import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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

export function startAgent(
  params: AgentParams,
  onChunk: (text: string) => void,
  onDone: (sessionId: string | null) => void,
  onError: (message: string) => void,
  onTool?: (tool: string) => void,
): AgentHandle {
  const requestId = crypto.randomUUID()
  const listeners: Array<() => void> = []
  let cancelled = false
  let cleaned = false
  let complete!: () => void
  const completed = new Promise<void>(resolve => { complete = resolve })
  const context = buildContext(params)
  const unlisten = (): void => {
    if (cleaned) return
    cleaned = true
    listeners.splice(0).forEach(fn => fn())
  }
  const register = async <T>(event: string, handler: (event: { payload: T }) => void): Promise<void> => {
    const cleanup = await listen<T>(event, handler)
    if (cleaned) cleanup()
    else listeners.push(cleanup)
  }
  const ready = (async (): Promise<void> => {
    try {
      await register<{ text: string }>(`agent://chunk:${requestId}`, e => { if (!cancelled) onChunk(e.payload.text) })
      await register<{ session_id: string | null }>(`agent://done:${requestId}`, e => { unlisten(); complete(); if (!cancelled) onDone(e.payload.session_id) })
      await register<{ message: string }>(`agent://error:${requestId}`, e => { unlisten(); complete(); if (!cancelled) onError(e.payload.message) })
      if (onTool) {
        await register<{ tool: string }>(`agent://tool:${requestId}`, e => { if (!cancelled) onTool(e.payload.tool) })
      }
      if (cancelled) { complete(); unlisten(); return }
      await invoke('start_agent', { args: {
        request_id: requestId,
        agent: params.agent,
        message: context.message,
        history: context.history,
        project_path: params.projectPath,
        session_id: params.sessionId ?? null,
        custom_executable: params.customExecutable ?? null,
        custom_args: params.customArgs ?? null,
        review: params.review ?? false,
      } })
    } catch (error) {
      complete()
      unlisten()
      throw error
    }
  })()
  return {
    requestId,
    ready,
    completed,
    cancel: async () => {
      cancelled = true
      try { await invoke('cancel_agent', { request_id: requestId }) }
      finally { complete(); unlisten() }
    },
    unlisten,
  }
}
