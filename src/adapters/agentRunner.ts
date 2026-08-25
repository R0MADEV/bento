import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { buildContext, type AgentHandle, type AgentParams } from '../core/ai/agentClient'

// Lanzar un agente por Tauri y escuchar sus eventos. Es el adaptador: aquí
// está el transporte, y en `core/ai/agentClient` lo que se le manda.

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
        cleanup_project_path: params.cleanupProjectPath ?? false,
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
