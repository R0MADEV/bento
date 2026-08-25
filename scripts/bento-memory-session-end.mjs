#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MEMORY_SCHEMA,
  normalizeMemoryEntry,
  normalizeTranscriptEntry,
  selectSummaryJobSql,
  upsertByExternalIdSql,
  upsertSummaryJobSql,
  upsertTranscriptSql,
  updateSummaryJobSql,
} from './lib/memoryStore.mjs'
import { generateTranscriptSummary, isNoMemorySummary, isUsefulSummary, terminateSummarizers } from './lib/transcriptSummary.mjs'
import { collectSessionMetadata, extractTranscript, extractVerification, metadataPrompt, transcriptHash } from './lib/sessionCapture.mjs'
import { defaultMemoryDbPath, sqliteBinary } from './lib/memoryPaths.mjs'

if (process.env.BENTO_MEMORY_FINALIZER === '1') process.exit(0)

// Safety net: this hook must never outlive its work. If anything hangs (a stdin
// that never closes, a stuck sqlite or summarizer child) force-exit, so we don't
// leak long-lived node processes (this previously piled up hundreds of zombies).
// .unref() so it never keeps the process alive when the work finishes early.
//
// Salir a secas mataba a node y dejaba al agente resumidor vivo por su cuenta,
// que es medio proceso huérfano por cada vez que esto salta: primero se corta a
// los hijos, y luego se sale.
setTimeout(() => {
  terminateSummarizers()
  process.exit(0)
}, Number(process.env.BENTO_MEMORY_HOOK_TIMEOUT_MS) || 300_000).unref()

const payload = await new Promise(resolve => {
  let input = ''
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    try { resolve(JSON.parse(input)) } catch { resolve({}) }
  }
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', finish)
  // stdin may never close in some launch paths — don't block forever waiting on it.
  setTimeout(finish, Number(process.env.BENTO_MEMORY_STDIN_TIMEOUT_MS) || 15_000).unref()
})
const agent = process.argv[2]
const transcriptPath = String(payload.transcript_path || payload.transcriptPath || '')
if (!['claude', 'codex'].includes(agent) || !transcriptPath) process.exit(0)

const raw = await readFile(transcriptPath, 'utf8').catch(() => '')
const transcript = extractTranscript(raw)
if (!transcript) process.exit(0)

const metadata = collectSessionMetadata(String(payload.cwd || process.cwd()))
metadata.verification = extractVerification(transcript)
const projectPath = metadata.projectPath
const sessionId = String(payload.session_id || payload.sessionId || basename(transcriptPath).replace(/\.[^.]+$/, ''))
const transcriptExternalId = `${agent}:session-transcript:${sessionId}`
const hash = transcriptHash(transcript)
const timestamp = new Date().toISOString()
const dbPath = defaultMemoryDbPath()
const sqliteBin = sqliteBinary()

const runSql = async (statement, read = false) => {
  await mkdir(dirname(dbPath), { recursive: true })
  return await new Promise((resolve, reject) => {
    const child = spawn(sqliteBin, read ? ['-json', dbPath] : [dbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(read && output.trim() ? JSON.parse(output) : [])
      : reject(new Error(error.trim() || `sqlite3 terminó con código ${code}`)))
    child.stdin.end(`.timeout 5000\n${MEMORY_SCHEMA}\n${statement}\n`)
  })
}

const transcriptEntry = normalizeTranscriptEntry({
  id: randomUUID(),
  project_path: projectPath,
  agent,
  session_id: sessionId,
  title: `Sesion ${agent}: ${basename(projectPath)}`,
  transcript,
  summary: '',
  source: `${agent}-session-end`,
  external_id: transcriptExternalId,
  created_at: timestamp,
  updated_at: timestamp,
})
const job = {
  id: randomUUID(),
  projectPath,
  agent,
  sessionId,
  transcriptExternalId,
  transcriptHash: hash,
  status: 'pending',
  error: '',
  attempts: 0,
  metadata,
  createdAt: timestamp,
  updatedAt: timestamp,
}

// Persist before starting the expensive summarizer. A crash can no longer lose
// the transcript, and the content hash prevents charging twice for the same end event.
const previousRows = await runSql(selectSummaryJobSql(projectPath, transcriptExternalId), true).catch(() => [])
await runSql(`${upsertTranscriptSql(transcriptEntry)}\n${upsertSummaryJobSql(job)}`).catch(() => {})

if (process.env.BENTO_MEMORY_SUMMARY_WORKER !== '1') {
  if (previousRows[0]?.transcript_hash === hash) process.exit(0)
  const worker = spawn(process.execPath, [process.argv[1], agent], {
    cwd: projectPath,
    detached: true,
    env: { ...process.env, BENTO_MEMORY_SUMMARY_WORKER: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  worker.stdin.end(JSON.stringify(payload))
  worker.unref()
  process.exit(0)
}

await runSql(`UPDATE memory_summary_jobs SET status = 'processing', error = '', updated_at = '${timestamp}' WHERE project_path = '${projectPath.replaceAll("'", "''")}' AND transcript_external_id = '${transcriptExternalId.replaceAll("'", "''")}';`).catch(() => {})

try {
  const summary = await generateTranscriptSummary(agent, projectPath, transcript, metadataPrompt(metadata))
  if (!isUsefulSummary(summary)) {
    const status = isNoMemorySummary(summary) ? 'skipped' : 'failed'
    const error = status === 'failed' ? 'El resumidor no devolvió un resultado válido.' : ''
    await runSql(updateSummaryJobSql(projectPath, transcriptExternalId, status, error))
    process.exit(0)
  }

  const completedTranscript = normalizeTranscriptEntry({ ...transcriptEntry, summary, updated_at: new Date().toISOString() })
  const externalId = `${agent}:session-summary:${sessionId}`
  const tags = ['session-summary', agent, metadata.branch ? `branch:${metadata.branch}` : ''].filter(Boolean)
  const entry = normalizeMemoryEntry({
    id: randomUUID(),
    project_path: projectPath,
    kind: 'note',
    title: `Resumen de sesion: ${basename(projectPath)}`,
    summary: summary.slice(0, 500),
    details: summary,
    tags,
    files: metadata.changedFiles,
    source: `${agent}-session-end`,
    external_id: externalId,
  })
  await runSql(`${upsertTranscriptSql(completedTranscript)}\n${upsertByExternalIdSql(entry)}\n${updateSummaryJobSql(projectPath, transcriptExternalId, 'completed')}`)

  const retentionDays = Math.max(0, Number(process.env.BENTO_MEMORY_TRANSCRIPT_RETENTION_DAYS) || 0)
  if (retentionDays > 0) {
    await runSql(`DELETE FROM memory_transcripts WHERE summary <> '' AND datetime(updated_at) < datetime('now', '-${retentionDays} days');`)
  }
} catch (error) {
  await runSql(updateSummaryJobSql(projectPath, transcriptExternalId, 'failed', error instanceof Error ? error.message : String(error))).catch(() => {})
}
