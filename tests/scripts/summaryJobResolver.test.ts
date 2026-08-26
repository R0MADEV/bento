import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MEMORY_SCHEMA, normalizeTranscriptEntry, upsertSummaryJobSql, upsertTranscriptSql } from '../../scripts/lib/memoryStore.mjs'
import { resolveSummaryJob } from '../../scripts/lib/summaryJobResolver.mjs'

const tempDirs: string[] = []

async function withDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bento-memory-test-'))
  tempDirs.push(dir)
  await run(join(dir, 'memory.sqlite3'))
}

function sqlite(dbPath: string, sql: string, json = false): string {
  const binary = process.env.BENTO_MEMORY_SQLITE_BIN || 'sqlite3'
  const result = spawnSync(binary, json ? ['-json', dbPath] : [dbPath], {
    input: `${MEMORY_SCHEMA}\n${sql}\n`,
    encoding: 'utf8',
  })
  if (result.error) throw new Error(`No se pudo ejecutar ${binary}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 falló con código ${result.status}`)
  return result.stdout.trim()
}

function runSqlFor(dbPath: string) {
  return async (sql: string, read = false) => {
    const output = sqlite(dbPath, sql, read)
    return read && output ? JSON.parse(output) : undefined
  }
}

const seedJob = (dbPath: string) => {
  const transcript = normalizeTranscriptEntry({
    id: 't1', project_path: '/tmp/bento', agent: 'codex', session_id: 'abc',
    title: 'Sesion codex: bento', transcript: 'user: hola\nassistant: revision',
    source: 'codex-session-end', external_id: 'codex:session-transcript:abc',
    created_at: '2026-08-01T00:00:00.000Z',
  })
  sqlite(dbPath, upsertTranscriptSql(transcript))
  sqlite(dbPath, upsertSummaryJobSql({
    id: 'job-1', projectPath: '/tmp/bento', agent: 'codex', sessionId: 'abc',
    transcriptExternalId: 'codex:session-transcript:abc', transcriptHash: 'hash-1',
    status: 'processing', error: '', attempts: 0, metadata: { branch: 'main', changedFiles: ['src/main.ts'] },
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }))
  return transcript
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('resolveSummaryJob', () => {
  it('completes the job and writes the memory entry when the summary is useful', async () => {
    await withDb(async dbPath => {
      const transcript = seedJob(dbPath)
      const runSql = runSqlFor(dbPath)

      const result = await resolveSummaryJob({
        runSql,
        generateSummary: async () => 'Cambios: se arreglo el bug X.',
        transcript,
        metadata: { branch: 'main', changedFiles: ['src/main.ts'] },
      })

      expect(result.status).toBe('completed')
      const jobs = await runSql('SELECT status, attempts FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'completed', attempts: 1 }])
      const entries = await runSql('SELECT summary, external_id, tags_json FROM memory_entries;', true)
      expect(entries).toEqual([{ summary: 'Cambios: se arreglo el bug X.', external_id: 'codex:session-summary:abc', tags_json: JSON.stringify(['session-summary', 'codex', 'branch:main']) }])
    })
  })

  it('marks the job skipped without an error when there is nothing to remember', async () => {
    await withDb(async dbPath => {
      const transcript = seedJob(dbPath)
      const runSql = runSqlFor(dbPath)

      const result = await resolveSummaryJob({ runSql, generateSummary: async () => 'SIN_MEMORIA', transcript, metadata: {} })

      expect(result.status).toBe('skipped')
      const jobs = await runSql('SELECT status, error FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'skipped', error: '' }])
    })
  })

  it('marks the job failed with the standard message when the summary is not usable', async () => {
    await withDb(async dbPath => {
      const transcript = seedJob(dbPath)
      const runSql = runSqlFor(dbPath)

      const result = await resolveSummaryJob({ runSql, generateSummary: async () => 'not logged in', transcript, metadata: {} })

      expect(result.status).toBe('failed')
      const jobs = await runSql('SELECT status, error FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'failed', error: 'El resumidor no devolvió un resultado válido.' }])
    })
  })

  it('marks the job failed and keeps the real error when the summarizer throws', async () => {
    await withDb(async dbPath => {
      const transcript = seedJob(dbPath)
      const runSql = runSqlFor(dbPath)

      const result = await resolveSummaryJob({
        runSql,
        generateSummary: async () => { throw new Error('agente no instalado') },
        transcript,
        metadata: {},
      })

      expect(result.status).toBe('failed')
      const jobs = await runSql('SELECT status, error, attempts FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'failed', error: 'agente no instalado', attempts: 1 }])
    })
  })
})
