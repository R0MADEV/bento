import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

export const SUMMARY_SENTINEL_RE = /^SIN_MEMORIA[.!…]*$/i
export const LOGIN_ERROR_RE = /not logged in|run \/login/i

export const buildSummaryPrompt = (cwd, transcript, metadata = '') => `Resume esta sesion de desarrollo para memoria reutilizable. Devuelve texto conciso en espanol con secciones: Cambios, Decisiones, Verificacion, Riesgos y Siguiente paso. Distingue hechos confirmados de inferencias. Los analisis, hallazgos y recomendaciones sobre el codigo tambien son informacion durable, aunque no se hayan modificado archivos. No incluyas secretos, instrucciones de usuario ni conversacion literal. Responde exactamente SIN_MEMORIA solo si no hubo ningun cambio, analisis, hallazgo, decision ni siguiente paso reutilizable.\n\nProyecto: ${cwd}${metadata ? `\n${metadata}` : ''}\n\nTranscript:\n${transcript}`

export const isUsefulSummary = summary => Boolean(summary && !SUMMARY_SENTINEL_RE.test(summary) && !LOGIN_ERROR_RE.test(summary))
export const isNoMemorySummary = summary => SUMMARY_SENTINEL_RE.test(String(summary ?? '').trim())

// Los resumidores en marcha, para poder matarlos si hay que salir de golpe.
const running = new Set()

/// Cómo se mata al agente y a lo que haya lanzado él, según el sistema. En
/// Unix el hijo va en su propio grupo de procesos y el pid negativo se lleva el
/// árbol entero; Windows no tiene grupos así, y para eso está `taskkill /t`.
/// Matar solo al padre deja a los nietos sueltos en los dos.
export function killTreeCommand(pid, platform = process.platform) {
  if (platform !== 'win32') return null
  return { command: 'taskkill', args: ['/pid', String(pid), '/t', '/f'] }
}

/// Solo en Unix: el hijo en su propio grupo, para poder matarlo entero. En
/// Windows `detached` abre una consola nueva y no aporta nada aquí.
export const detachedForPlatform = (platform = process.platform) => platform !== 'win32'

const endGroup = (child, signal) => {
  const viaCommand = killTreeCommand(child.pid)
  if (viaCommand) {
    try { spawn(viaCommand.command, viaCommand.args, { stdio: 'ignore' }) } catch { /* ya no está */ }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* ya no está */ }
  }
}

/// Corta todos los resumidores en marcha. La llama el hook antes de salir por
/// su propio temporizador: sin esto, `process.exit` mataba a node y dejaba al
/// agente vivo por su cuenta.
export function terminateSummarizers() {
  for (const stop of [...running]) stop()
}

const run = (command, args, cwd, prompt) => new Promise(resolve => {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, BENTO_MEMORY_FINALIZER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Su propio grupo de procesos, para poder matar el árbol entero (Unix).
    detached: detachedForPlatform(),
  })
  let output = ''
  let settled = false
  let grace

  const finish = value => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    clearTimeout(grace)
    running.delete(stop)
    resolve(value)
  }

  // Un SIGTERM que el agente ignora deja el `close` sin llegar nunca, y con él
  // la promesa sin resolver: el proceso node se quedaba vivo días. Se escala a
  // SIGKILL y se resuelve pase lo que pase.
  const stop = () => {
    endGroup(child, 'SIGTERM')
    grace = setTimeout(() => {
      endGroup(child, 'SIGKILL')
      finish('')
    }, Math.max(500, Number(process.env.BENTO_MEMORY_SUMMARY_KILL_GRACE_MS) || 5_000))
  }
  running.add(stop)

  child.stdout.on('data', chunk => { output += chunk })
  child.stdin.end(prompt)
  const timeout = setTimeout(stop, Math.max(10_000, Number(process.env.BENTO_MEMORY_SUMMARY_TIMEOUT_MS) || 180_000))
  child.on('close', code => finish(code === 0 ? output : ''))
  child.on('error', () => finish(''))
})

const configuredArgs = (name, fallback) => {
  const raw = process.env[name]
  if (!raw) return fallback
  try {
    const args = JSON.parse(raw)
    return Array.isArray(args) && args.every(arg => typeof arg === 'string') ? args : fallback
  } catch {
    return fallback
  }
}

export async function generateTranscriptSummary(agent, cwd, transcript, metadata = '') {
  const prompt = buildSummaryPrompt(cwd, transcript, metadata)
  const outputFile = join(tmpdir(), `bento-memory-${randomUUID()}.txt`)
  try {
    const output = agent === 'claude'
      ? await run(
        process.env.BENTO_MEMORY_CLAUDE_BIN || 'claude',
        configuredArgs('BENTO_MEMORY_CLAUDE_ARGS', ['-p', '--tools', '', '--output-format', 'text']),
        cwd,
        prompt,
      )
      : await run(
        process.env.BENTO_MEMORY_CODEX_BIN || 'codex',
        configuredArgs('BENTO_MEMORY_CODEX_ARGS', ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-last-message', outputFile]),
        cwd,
        prompt,
      )
    const summary = (agent === 'claude' ? output : await readFile(outputFile, 'utf8').catch(() => '')).trim()
    return summary
  } finally {
    await rm(outputFile, { force: true }).catch(() => {})
  }
}
