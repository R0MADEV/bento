import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MAX_TRANSCRIPT_CHARS = 180_000

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]'],
  [/\b(sk-(?:proj-)?|sk-ant-|gh[opsu]_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED_TOKEN]'],
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY))\s*[=:]\s*([^\s,;]+)/g, '$1=[REDACTED]'],
]

export function redactSecrets(value) {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value ?? ''))
}

function contentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  for (const key of ['content', 'message', 'output', 'result']) {
    const text = contentText(value[key])
    if (text) return text
  }
  return ''
}

export function extractTranscript(raw, maxChars = MAX_TRANSCRIPT_CHARS) {
  const text = String(raw ?? '').split('\n').map(line => {
    if (!line.trim()) return ''
    try {
      const row = JSON.parse(line)
      const content = contentText(
        row.message
        ?? row.payload?.message
        ?? row.payload?.content
        ?? row.content
        ?? row.output
        ?? row.result,
      )
      if (!content.trim()) return ''
      const role = row.role ?? row.message?.role ?? row.payload?.role ?? row.type ?? 'message'
      return `${role}: ${content.trim()}`
    } catch {
      return line.trim()
    }
  }).filter(Boolean).join('\n')
  return redactSecrets(text.slice(-maxChars)).trim()
}

const git = (cwd, args) => {
  const result = spawnSync(process.env.BENTO_MEMORY_GIT_BIN || 'git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 3000,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

export function collectSessionMetadata(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const projectPath = root || (() => {
    try { return realpathSync(cwd) } catch { return cwd }
  })()
  const changed = git(projectPath, ['status', '--short']).split('\n').filter(Boolean)
  return {
    projectPath,
    branch: git(projectPath, ['branch', '--show-current']),
    commit: git(projectPath, ['rev-parse', 'HEAD']),
    changedFiles: changed.map(line => line.slice(3).trim()).filter(Boolean).slice(0, 100),
    gitStatus: changed.slice(0, 100),
  }
}

export const transcriptHash = transcript => createHash('sha256').update(String(transcript ?? '')).digest('hex')

export function extractVerification(transcript) {
  return String(transcript ?? '').split('\n')
    .filter(line => /\b(test(?:s|ed|ing)?|passed|failed|build|compil(?:e|ed|ación)|cargo test|npm test|vitest|pytest)\b/i.test(line))
    .slice(-20)
}

export function metadataPrompt(metadata) {
  return [
    metadata.branch ? `Rama: ${metadata.branch}` : '',
    metadata.commit ? `Commit: ${metadata.commit}` : '',
    metadata.changedFiles?.length ? `Archivos modificados: ${metadata.changedFiles.join(', ')}` : '',
    metadata.gitStatus?.length ? `Estado Git:\n${metadata.gitStatus.join('\n')}` : '',
    metadata.verification?.length ? `Verificación detectada:\n${metadata.verification.join('\n')}` : '',
  ].filter(Boolean).join('\n')
}
