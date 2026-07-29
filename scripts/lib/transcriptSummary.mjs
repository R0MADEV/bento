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

const run = (command, args, cwd, prompt) => new Promise(resolve => {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, BENTO_MEMORY_FINALIZER: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stdin.end(prompt)
  const timeout = setTimeout(() => child.kill('SIGTERM'), Math.max(10_000, Number(process.env.BENTO_MEMORY_SUMMARY_TIMEOUT_MS) || 180_000))
  child.on('close', code => {
    clearTimeout(timeout)
    resolve(code === 0 ? output : '')
  })
  child.on('error', () => {
    clearTimeout(timeout)
    resolve('')
  })
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
