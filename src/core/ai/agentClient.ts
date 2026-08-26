// Lo que se le manda a un agente y cómo se recorta para que quepa: contexto,
// historial, redacción de secretos y qué sesión se puede reanudar. Puro — el
// lanzamiento vive en `adapters/agentRunner`.

import type { AgentType } from './config'

export type { AgentType }

export interface AgentMessage {
  role: string
  content: string
}

export interface AgentParams {
  agent: AgentType
  message: string
  history: AgentMessage[]
  projectPath: string
  sessionId?: string | null
  review?: boolean
  cleanupProjectPath?: boolean
  customExecutable?: string
  customArgs?: string[]
  diff?: string
  lexisSnippets?: string[]
}

export interface AgentHandle {
  requestId: string
  ready: Promise<void>
  completed: Promise<void>
  cancel: () => Promise<void>
  unlisten: () => void
}

export const MAX_CONTEXT_CHARS = 40_000
const HISTORY_RESERVE = Math.floor(MAX_CONTEXT_CHARS * 0.3)
const SECRET_RE = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,})/g

export function redact(value: string): string {
  return value.replace(SECRET_RE, '[REDACTED]')
}

export function truncateHistory(history: AgentMessage[], budget = HISTORY_RESERVE): AgentMessage[] {
  let chars = 0
  const result: AgentMessage[] = []
  for (const message of [...history].reverse()) {
    const clean = { role: message.role, content: redact(message.content) }
    const next = chars + clean.content.length
    if (next > budget) break
    chars = next
    result.unshift(clean)
  }
  return result
}

export interface ReviewSessionContext {
  branch?: string
  commit?: string
  sessionId?: string
  sessionAgent?: string
  sessionCommit?: string
}

// Review sessions are keyed by branch, agent and commit: only resume when all match.
export function resolvePersistedSessionId(ctx: ReviewSessionContext | undefined, agent: AgentType, currentCommit: string): string | null {
  if (!ctx?.branch || !currentCommit) return null
  if (ctx.sessionAgent !== agent) return null
  if (ctx.sessionCommit !== currentCommit) return null
  return ctx.sessionId ?? null
}

// On a fresh review session, appends the previous run's tool evidence to the
// message so the new agent process starts with findings it can no longer see.
export function buildReviewMessage(message: string, evidence: string[] | undefined, hasPersistedSession: boolean): string {
  const items = evidence ?? []
  if (hasPersistedSession || items.length === 0) return message
  const lines = items.slice(-20).map(item => `- ${item}`).join('\n')
  return `${message}\n\nPersisted review evidence:\n${lines}`
}

export function buildContext(params: AgentParams): { message: string; history: AgentMessage[] } {
  const budget = MAX_CONTEXT_CHARS - HISTORY_RESERVE
  const pieces = [params.message, params.diff ?? '', ...(params.lexisSnippets ?? [])]
    .map(redact)
    .filter(Boolean)
  const marker = '\n[context truncated]'
  let message = ''
  for (const piece of pieces) {
    const separator = message ? '\n\n' : ''
    const available = budget - message.length - separator.length
    if (piece.length <= available) {
      message += separator + piece
      continue
    }
    const sliceLength = available - marker.length
    message += separator + (sliceLength > 0 ? piece.slice(0, sliceLength) : '') + marker
    break
  }
  return { message, history: truncateHistory(params.history) }
}
