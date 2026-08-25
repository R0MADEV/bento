import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateTranscriptSummary, terminateSummarizers } from '../../scripts/lib/transcriptSummary.mjs'

// El resumidor es un agente de verdad (claude/codex) lanzado como proceso hijo.
// Estos tests usan scripts que se portan mal a propósito: lo que se comprueba es
// que el hook no se queda colgado ni deja hijos sueltos, que es lo que llenaba
// la máquina de procesos node de días de antigüedad.
let dir: string

const script = (name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

const stillRunning = (pattern: string): number => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bento-summary-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('el resumidor de sesiones', () => {
  it('devuelve lo que escribe un agente que se porta bien', async () => {
    process.env.BENTO_MEMORY_CLAUDE_BIN = script('ok.sh', '#!/bin/sh\ncat > /dev/null\necho "un resumen"\n')
    process.env.BENTO_MEMORY_CLAUDE_ARGS = '[]'
    await expect(generateTranscriptSummary('claude', dir, 'transcript')).resolves.toBe('un resumen')
  })

  it('no se queda colgado con un agente que ignora SIGTERM', async () => {
    // Sin escalar a SIGKILL, `close` no llega nunca y la promesa no resuelve:
    // el proceso node se quedaba vivo días.
    const bin = script('terco.sh', `#!/bin/sh\ntrap '' TERM\ncat > /dev/null\nsleep 120\n`)
    process.env.BENTO_MEMORY_CLAUDE_BIN = bin
    process.env.BENTO_MEMORY_CLAUDE_ARGS = '[]'
    process.env.BENTO_MEMORY_SUMMARY_TIMEOUT_MS = '1000'
    process.env.BENTO_MEMORY_SUMMARY_KILL_GRACE_MS = '500'

    const started = Date.now()
    await expect(generateTranscriptSummary('claude', dir, 'transcript')).resolves.toBe('')
    expect(Date.now() - started).toBeLessThan(15_000)
    // Y no deja el agente suelto detrás.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(stillRunning(bin)).toBe(0)
  }, 30_000)

  it('mata a los agentes en marcha cuando se le pide salir', async () => {
    const bin = script('lento.sh', `#!/bin/sh\ntrap '' TERM\ncat > /dev/null\nsleep 120\n`)
    process.env.BENTO_MEMORY_CLAUDE_BIN = bin
    process.env.BENTO_MEMORY_CLAUDE_ARGS = '[]'
    process.env.BENTO_MEMORY_SUMMARY_TIMEOUT_MS = '60000'
    delete process.env.BENTO_MEMORY_SUMMARY_KILL_GRACE_MS

    const pending = generateTranscriptSummary('claude', dir, 'transcript')
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(stillRunning(bin)).toBeGreaterThan(0)

    terminateSummarizers()
    await expect(pending).resolves.toBe('')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(stillRunning(bin)).toBe(0)
  }, 30_000)
})
