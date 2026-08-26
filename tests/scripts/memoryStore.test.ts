import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  MEMORY_SCHEMA,
  insertEntrySql,
  normalizeMemoryEntry,
  normalizeMemoryPatch,
  normalizeTranscriptEntry,
  rowToEntry,
  selectByExternalIdSql,
  selectStaleSummaryJobsSql,
  upsertTranscriptSql,
  upsertByExternalIdSql,
  upsertSummaryJobSql,
} from '../../scripts/lib/memoryStore.mjs'

const tempDirs: string[] = []

function withDb(run: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bento-memory-test-'))
  tempDirs.push(dir)
  run(join(dir, 'memory.sqlite3'))
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

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('memoryStore', () => {
  it('normalizes and validates a new entry', () => {
    const entry = normalizeMemoryEntry({
      id: ' 1 ',
      project_path: ' /tmp/bento ',
      kind: 'note',
      title: '  titulo ',
      summary: ' resumen ',
      details: ' detalle ',
      tags: [' sqlite ', 'sqlite', '', 'memory'],
      files: [' src/main.ts ', 'src/main.ts'],
      source: ' codex ',
      external_id: ' ext-1 ',
      created_at: '2026-07-28T20:00:00.000Z',
    })

    expect(entry).toMatchObject({
      id: '1',
      projectPath: '/tmp/bento',
      title: 'titulo',
      summary: 'resumen',
      details: 'detalle',
      tags: ['sqlite', 'memory'],
      files: ['src/main.ts'],
      source: 'codex',
      externalId: 'ext-1',
      createdAt: '2026-07-28T20:00:00.000Z',
      updatedAt: '2026-07-28T20:00:00.000Z',
    })
  })

  it('preserves invariants when patching an entry', () => {
    const current = normalizeMemoryEntry({
      id: '1',
      project_path: '/tmp/bento',
      kind: 'note',
      title: 'titulo',
      summary: 'resumen',
      details: 'detalle',
      tags: ['memory'],
      files: ['src/main.ts'],
      source: 'codex',
      external_id: 'ext-1',
      created_at: '2026-07-28T20:00:00.000Z',
    })

    const patched = normalizeMemoryPatch(current, {
      summary: ' resumen nuevo ',
      tags: [' sqlite ', 'sqlite'],
      external_id: ' ext-2 ',
    }, '2026-07-28T21:00:00.000Z')

    expect(patched.summary).toBe('resumen nuevo')
    expect(patched.tags).toEqual(['sqlite'])
    expect(patched.externalId).toBe('ext-2')
    expect(patched.updatedAt).toBe('2026-07-28T21:00:00.000Z')
  })

  it('upserts by external_id and keeps a single row per project', () => {
    withDb(dbPath => {
      const first = normalizeMemoryEntry({
        id: '1',
        project_path: '/tmp/bento',
        kind: 'note',
        title: 'Resumen de sesion: bento',
        summary: 'primer resumen',
        details: 'detalle 1',
        tags: ['session-summary', 'codex'],
        files: [],
        source: 'codex-session-end',
        external_id: 'codex:session-summary:abc',
        created_at: '2026-07-28T20:00:00.000Z',
        updated_at: '2026-07-28T20:00:00.000Z',
      })
      const second = normalizeMemoryEntry({
        ...first,
        id: '2',
        summary: 'segundo resumen',
        details: 'detalle 2',
        updated_at: '2026-07-28T20:05:00.000Z',
      })

      sqlite(dbPath, upsertByExternalIdSql(first))
      sqlite(dbPath, upsertByExternalIdSql(second))

      const rows = JSON.parse(sqlite(dbPath, 'SELECT * FROM memory_entries;', true))
      expect(rows).toHaveLength(1)
      const entry = rowToEntry(rows[0])
      expect(entry.summary).toBe('segundo resumen')
      expect(entry.details).toBe('detalle 2')
      expect(entry.id).toBe('1')
    })
  })

  it('returns the existing row when inserting a duplicate external_id through the MCP path', () => {
    withDb(dbPath => {
      const first = normalizeMemoryEntry({
        id: '1',
        project_path: '/tmp/bento',
        kind: 'fact',
        title: 'Arquitectura',
        summary: 'original',
        details: 'detalle',
        tags: [],
        files: [],
        source: 'mcp',
        external_id: 'shared-id',
        created_at: '2026-07-28T20:00:00.000Z',
      })

      sqlite(dbPath, insertEntrySql(first))
      const rows = JSON.parse(sqlite(dbPath, selectByExternalIdSql('/tmp/bento', 'shared-id'), true))
      expect(rows).toHaveLength(1)
      const entry = rowToEntry(rows[0])
      expect(entry.title).toBe('Arquitectura')
      expect(entry.externalId).toBe('shared-id')
    })
  })

  it('upserts transcripts by external_id and keeps the latest summary', () => {
    withDb(dbPath => {
      const first = normalizeTranscriptEntry({
        id: 't1',
        project_path: '/tmp/bento',
        agent: 'codex',
        session_id: 'abc',
        title: 'Sesion codex: bento',
        transcript: 'user: hola\nassistant: revision',
        summary: 'primer resumen',
        source: 'codex-session-end',
        external_id: 'codex:session-transcript:abc',
        created_at: '2026-07-28T20:00:00.000Z',
      })
      const second = normalizeTranscriptEntry({
        ...first,
        id: 't2',
        summary: 'segundo resumen',
        updated_at: '2026-07-28T20:10:00.000Z',
      })

      sqlite(dbPath, upsertTranscriptSql(first))
      sqlite(dbPath, upsertTranscriptSql(second))

      const rows = JSON.parse(sqlite(dbPath, 'SELECT summary, external_id FROM memory_transcripts;', true))
      expect(rows).toHaveLength(1)
      expect(rows[0].summary).toBe('segundo resumen')
      expect(rows[0].external_id).toBe('codex:session-transcript:abc')
    })
  })

  it('keeps completed summary jobs idempotent for the same transcript hash', () => {
    withDb(dbPath => {
      const base = {
        id: 'job-1', projectPath: '/tmp/bento', agent: 'codex', sessionId: 'abc',
        transcriptExternalId: 'codex:session-transcript:abc', transcriptHash: 'hash-1',
        status: 'completed', error: '', attempts: 1, metadata: { branch: 'main' },
        createdAt: '2026-07-28T20:00:00.000Z', updatedAt: '2026-07-28T20:00:00.000Z',
      }
      sqlite(dbPath, upsertSummaryJobSql(base))
      sqlite(dbPath, upsertSummaryJobSql({ ...base, id: 'job-2', status: 'pending' }))
      const rows = JSON.parse(sqlite(dbPath, 'SELECT status, transcript_hash FROM memory_summary_jobs;', true))
      expect(rows).toEqual([{ status: 'completed', transcript_hash: 'hash-1' }])
    })
  })

  it('does not reset a failed job until the user explicitly retries it', () => {
    withDb(dbPath => {
      const base = {
        id: 'job-1', projectPath: '/tmp/bento', agent: 'claude', sessionId: 'abc',
        transcriptExternalId: 'claude:session-transcript:abc', transcriptHash: 'hash-1',
        status: 'failed', error: 'login', attempts: 1, metadata: {},
        createdAt: '2026-07-28T20:00:00.000Z', updatedAt: '2026-07-28T20:00:00.000Z',
      }
      sqlite(dbPath, upsertSummaryJobSql(base))
      sqlite(dbPath, upsertSummaryJobSql({ ...base, status: 'pending', error: '' }))
      const rows = JSON.parse(sqlite(dbPath, 'SELECT status, attempts FROM memory_summary_jobs;', true))
      expect(rows).toEqual([{ status: 'failed', attempts: 1 }])
    })
  })

  describe('selectStaleSummaryJobsSql', () => {
    const seedJob = (dbPath: string, transcript: ReturnType<typeof normalizeTranscriptEntry>, job: Record<string, unknown>) => {
      sqlite(dbPath, upsertTranscriptSql(transcript))
      sqlite(dbPath, upsertSummaryJobSql(job))
    }

    it('picks up pending/processing jobs stuck before the cutoff, joined with their transcript', () => {
      withDb(dbPath => {
        const transcript = normalizeTranscriptEntry({
          id: 't1', project_path: '/tmp/bento', agent: 'codex', session_id: 'abc',
          title: 'Sesion codex: bento', transcript: 'user: hola\nassistant: revision',
          source: 'codex-session-end', external_id: 'codex:session-transcript:abc',
          created_at: '2026-08-01T00:00:00.000Z',
        })
        seedJob(dbPath, transcript, {
          id: 'job-1', projectPath: '/tmp/bento', agent: 'codex', sessionId: 'abc',
          transcriptExternalId: 'codex:session-transcript:abc', transcriptHash: 'hash-1',
          status: 'pending', error: '', attempts: 0, metadata: { branch: 'main' },
          createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
        })

        const rows = JSON.parse(sqlite(dbPath, selectStaleSummaryJobsSql('2026-08-20T00:00:00.000Z', 5, 3), true))

        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          project_path: '/tmp/bento', agent: 'codex', session_id: 'abc',
          transcript_external_id: 'codex:session-transcript:abc',
          transcript_text: 'user: hola\nassistant: revision',
        })
      })
    })

    it('ignores jobs newer than the cutoff, already finished, or past the retry limit', () => {
      withDb(dbPath => {
        const transcriptFor = (sessionId: string) => normalizeTranscriptEntry({
          id: `t-${sessionId}`, project_path: '/tmp/bento', agent: 'codex', session_id: sessionId,
          title: 'Sesion codex: bento', transcript: 'user: hola',
          source: 'codex-session-end', external_id: `codex:session-transcript:${sessionId}`,
          created_at: '2026-08-01T00:00:00.000Z',
        })
        const jobFor = (sessionId: string, overrides: Record<string, unknown>) => ({
          id: `job-${sessionId}`, projectPath: '/tmp/bento', agent: 'codex', sessionId,
          transcriptExternalId: `codex:session-transcript:${sessionId}`, transcriptHash: `hash-${sessionId}`,
          status: 'pending', error: '', attempts: 0, metadata: {},
          createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
          ...overrides,
        })

        seedJob(dbPath, transcriptFor('too-new'), jobFor('too-new', { updatedAt: '2026-08-25T23:59:00.000Z' }))
        seedJob(dbPath, transcriptFor('completed'), jobFor('completed', { status: 'completed' }))
        seedJob(dbPath, transcriptFor('exhausted'), jobFor('exhausted', { attempts: 5 }))
        seedJob(dbPath, transcriptFor('due'), jobFor('due', {}))

        const rows = JSON.parse(sqlite(dbPath, selectStaleSummaryJobsSql('2026-08-20T00:00:00.000Z', 5, 3), true))

        expect(rows.map((row: { session_id: string }) => row.session_id)).toEqual(['due'])
      })
    })

    it('caps how many stale jobs come back at once', () => {
      withDb(dbPath => {
        for (const sessionId of ['a', 'b', 'c']) {
          seedJob(dbPath,
            normalizeTranscriptEntry({
              id: `t-${sessionId}`, project_path: '/tmp/bento', agent: 'codex', session_id: sessionId,
              title: 'Sesion codex: bento', transcript: 'user: hola',
              source: 'codex-session-end', external_id: `codex:session-transcript:${sessionId}`,
              created_at: '2026-08-01T00:00:00.000Z',
            }),
            {
              id: `job-${sessionId}`, projectPath: '/tmp/bento', agent: 'codex', sessionId,
              transcriptExternalId: `codex:session-transcript:${sessionId}`, transcriptHash: `hash-${sessionId}`,
              status: 'pending', error: '', attempts: 0, metadata: {},
              createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
            })
        }

        const rows = JSON.parse(sqlite(dbPath, selectStaleSummaryJobsSql('2026-08-20T00:00:00.000Z', 5, 2), true))

        expect(rows).toHaveLength(2)
      })
    })
  })
})
