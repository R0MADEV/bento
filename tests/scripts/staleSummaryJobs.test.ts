import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MEMORY_SCHEMA, normalizeTranscriptEntry, upsertSummaryJobSql, upsertTranscriptSql } from '../../scripts/lib/memoryStore.mjs'
import { sweepStaleSummaryJobs } from '../../scripts/lib/staleSummaryJobs.mjs'

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

const seedStaleJob = (dbPath: string, sessionId: string, overrides: Record<string, unknown> = {}) => {
  const transcript = normalizeTranscriptEntry({
    id: `t-${sessionId}`, project_path: '/tmp/bento', agent: 'codex', session_id: sessionId,
    title: 'Sesion codex: bento', transcript: 'user: hola\nassistant: revision',
    source: 'codex-session-end', external_id: `codex:session-transcript:${sessionId}`,
    created_at: '2026-08-01T00:00:00.000Z',
  })
  sqlite(dbPath, upsertTranscriptSql(transcript))
  sqlite(dbPath, upsertSummaryJobSql({
    id: `job-${sessionId}`, projectPath: '/tmp/bento', agent: 'codex', sessionId,
    transcriptExternalId: `codex:session-transcript:${sessionId}`, transcriptHash: `hash-${sessionId}`,
    status: 'pending', error: '', attempts: 0, metadata: { branch: 'main', changedFiles: ['src/main.ts'] },
    createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  }))
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('sweepStaleSummaryJobs', () => {
  it('completes a stale job and writes the memory entry', async () => {
    await withDb(async dbPath => {
      seedStaleJob(dbPath, 'abc')
      const runSql = runSqlFor(dbPath)

      const results = await sweepStaleSummaryJobs({
        runSql,
        generateSummary: async () => 'Cambios: se arreglo el bug X.',
        staleAfterMs: 0,
      })

      expect(results).toEqual([{ projectPath: '/tmp/bento', transcriptExternalId: 'codex:session-transcript:abc', status: 'completed' }])
      const jobs = await runSql('SELECT status, attempts FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'completed', attempts: 1 }])
      const entries = await runSql("SELECT summary, external_id FROM memory_entries;", true)
      expect(entries).toEqual([{ summary: 'Cambios: se arreglo el bug X.', external_id: 'codex:session-summary:abc' }])
    })
  })

  it('marks a job skipped when the summarizer finds nothing worth keeping', async () => {
    await withDb(async dbPath => {
      seedStaleJob(dbPath, 'abc')
      const runSql = runSqlFor(dbPath)

      await sweepStaleSummaryJobs({ runSql, generateSummary: async () => 'SIN_MEMORIA', staleAfterMs: 0 })

      const jobs = await runSql('SELECT status, error FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'skipped', error: '' }])
    })
  })

  it('marks a job failed and keeps the error when the summarizer throws', async () => {
    await withDb(async dbPath => {
      seedStaleJob(dbPath, 'abc')
      const runSql = runSqlFor(dbPath)

      await sweepStaleSummaryJobs({
        runSql,
        generateSummary: async () => { throw new Error('agente no instalado') },
        staleAfterMs: 0,
      })

      const jobs = await runSql('SELECT status, error, attempts FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'failed', error: 'agente no instalado', attempts: 1 }])
    })
  })

  it('leaves recent jobs alone', async () => {
    await withDb(async dbPath => {
      seedStaleJob(dbPath, 'abc', { updatedAt: new Date().toISOString() })
      const runSql = runSqlFor(dbPath)

      const results = await sweepStaleSummaryJobs({ runSql, generateSummary: async () => 'no debería llamarse' })

      expect(results).toEqual([])
      const jobs = await runSql('SELECT status FROM memory_summary_jobs;', true)
      expect(jobs).toEqual([{ status: 'pending' }])
    })
  })

  it('respects the batch size across multiple stale jobs', async () => {
    await withDb(async dbPath => {
      seedStaleJob(dbPath, 'a')
      seedStaleJob(dbPath, 'b')
      seedStaleJob(dbPath, 'c')
      const runSql = runSqlFor(dbPath)

      const results = await sweepStaleSummaryJobs({
        runSql,
        generateSummary: async () => 'un resumen util',
        staleAfterMs: 0,
        batchSize: 2,
      })

      expect(results).toHaveLength(2)
    })
  })
})
