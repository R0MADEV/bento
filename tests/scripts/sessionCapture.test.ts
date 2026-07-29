import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { extractTranscript, extractVerification, redactSecrets, transcriptHash } from '../../scripts/lib/sessionCapture.mjs'

const tempDirs: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bento-session-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('sessionCapture', () => {
  it('extracts text and tool results from JSONL variants', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Corrige el fallo' }] } }),
      JSON.stringify({ type: 'tool_result', result: { content: [{ type: 'text', text: '380 tests passed' }] } }),
    ].join('\n')
    expect(extractTranscript(raw)).toContain('user: Corrige el fallo')
    expect(extractTranscript(raw)).toContain('tool_result: 380 tests passed')
  })

  it('redacts common credentials before persistence', () => {
    const text = redactSecrets('OPENAI_API_KEY=secret-value Bearer abcdefghijklmnopqrstuvwxyz sk-proj-abcdefghijklmnop')
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(text).not.toContain('sk-proj-abcdefghijklmnop')
    expect(text).toContain('[REDACTED]')
  })

  it('creates a stable content hash', () => {
    expect(transcriptHash('same')).toBe(transcriptHash('same'))
    expect(transcriptHash('same')).not.toBe(transcriptHash('different'))
  })

  it('extracts local verification evidence without another model call', () => {
    expect(extractVerification('cambio aplicado\nnpm test: 385 tests passed\nfin')).toEqual(['npm test: 385 tests passed'])
  })

  it('persists transcript and completes one summary job', () => {
    const dir = tempDir()
    const transcriptPath = join(dir, 'session.jsonl')
    const dbPath = join(dir, 'memory.sqlite3')
    const fakeClaude = join(dir, 'fake-claude.mjs')
    writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Implementa la cola persistente' } }))
    writeFileSync(fakeClaude, 'console.log("Cambios: cola persistente. Decisiones: SQLite. Verificacion: pruebas. Riesgos: ninguno. Siguiente paso: validar.")\n')

    const result = spawnSync(process.execPath, [resolve('scripts/bento-memory-session-end.mjs'), 'claude'], {
      cwd: resolve('.'),
      input: JSON.stringify({ cwd: resolve('.'), transcript_path: transcriptPath, session_id: 'test-session' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        BENTO_MEMORY_DB: dbPath,
        BENTO_MEMORY_SUMMARY_WORKER: '1',
        BENTO_MEMORY_CLAUDE_BIN: process.execPath,
        BENTO_MEMORY_CLAUDE_ARGS: JSON.stringify([fakeClaude]),
      },
    })
    expect(result.status, result.stderr).toBe(0)

    const query = spawnSync(process.env.BENTO_MEMORY_SQLITE_BIN || 'sqlite3', ['-json', dbPath], {
      input: "SELECT status, attempts FROM memory_summary_jobs; SELECT length(transcript) AS transcript_length, length(summary) AS summary_length FROM memory_transcripts;",
      encoding: 'utf8',
    })
    expect(query.error, query.error?.message).toBeUndefined()
    expect(query.status, query.stderr).toBe(0)
    expect(query.stdout).toContain('completed')
    expect(query.stdout).toContain('transcript_length')
    expect(readFileSync(transcriptPath, 'utf8')).toContain('Implementa la cola')
  })
})
