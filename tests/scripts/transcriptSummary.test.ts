import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  detachedForPlatform,
  generateTranscriptSummary,
  killTreeCommand,
  terminateSummarizers,
} from '../../scripts/lib/transcriptSummary.mjs'

// El resumidor lanza un agente de verdad como proceso hijo. Lo que importa es
// que el hook no se cuelgue esperándolo ni lo deje suelto al salir: eso era lo
// que llenaba la máquina de procesos node de días de antigüedad.

describe('cómo se mata al agente en cada sistema', () => {
  it('en Windows usa taskkill, que se lleva el árbol', () => {
    expect(killTreeCommand(1234, 'win32')).toEqual({
      command: 'taskkill',
      args: ['/pid', '1234', '/t', '/f'],
    })
    // Y allí `detached` no aporta nada: solo abre una consola.
    expect(detachedForPlatform('win32')).toBe(false)
  })

  it('en Unix no hace falta comando: se mata el grupo de procesos', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(killTreeCommand(1234, platform)).toBeNull()
      expect(detachedForPlatform(platform)).toBe(true)
    }
  })
})

// Los siguientes lanzan procesos y dependen de cómo trata las señales cada
// sistema: en Windows no se puede ignorar un SIGTERM, así que no dicen nada.
const unix = process.platform === 'win32' ? describe.skip : describe

unix('el resumidor, con agentes de verdad', () => {
  let dir: string

  // Un "agente" en Node, no en shell: así vale en cualquier sistema. El nombre
  // lleva un id único porque los tests lo buscan por línea de comandos: un
  // resto de una ejecución anterior contaría como si siguiera vivo.
  const agent = (name: string, body: string): string => {
    const path = join(dir, `${name}-${randomUUID()}.mjs`)
    writeFileSync(path, body)
    return path
  }

  const useAgent = (path: string): void => {
    process.env.BENTO_MEMORY_CLAUDE_BIN = process.execPath
    process.env.BENTO_MEMORY_CLAUDE_ARGS = JSON.stringify([path])
  }

  const stillRunning = (pattern: string): number => {
    try {
      return execFileSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  const STUBBORN = `process.on('SIGTERM', () => {})\nprocess.stdin.resume()\nsetTimeout(() => {}, 120000)\n`

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bento-summary-')) })
  afterAll(() => {
    terminateSummarizers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('devuelve lo que escribe un agente que se porta bien', async () => {
    useAgent(agent('ok', `process.stdin.resume()\nprocess.stdout.write('un resumen')\nprocess.exit(0)\n`))
    await expect(generateTranscriptSummary('claude', dir, 'transcript')).resolves.toBe('un resumen')
  })

  it('no se queda colgado con un agente que ignora SIGTERM', async () => {
    // Sin escalar a SIGKILL, `close` no llega nunca y la promesa no resuelve.
    const bin = agent('terco', STUBBORN)
    useAgent(bin)
    process.env.BENTO_MEMORY_SUMMARY_TIMEOUT_MS = '1000'
    process.env.BENTO_MEMORY_SUMMARY_KILL_GRACE_MS = '500'

    const started = Date.now()
    await expect(generateTranscriptSummary('claude', dir, 'transcript')).resolves.toBe('')
    expect(Date.now() - started).toBeLessThan(20_000)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(stillRunning(bin)).toBe(0)
  }, 30_000)

  it('mata a los agentes en marcha cuando se le pide salir', async () => {
    const bin = agent('lento', STUBBORN)
    useAgent(bin)
    process.env.BENTO_MEMORY_SUMMARY_TIMEOUT_MS = '60000'
    process.env.BENTO_MEMORY_SUMMARY_KILL_GRACE_MS = '500'

    const pending = generateTranscriptSummary('claude', dir, 'transcript')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(stillRunning(bin)).toBeGreaterThan(0)

    terminateSummarizers()
    await expect(pending).resolves.toBe('')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(stillRunning(bin)).toBe(0)
  }, 30_000)
})
