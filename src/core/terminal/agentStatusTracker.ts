export type AgentStatus = 'idle' | 'working' | 'blocked'

export interface AgentStatusTracker {
  onCommandStart(): void
  onCommandEnd(): void
  onOutput(): void
  onChange(cb: (status: AgentStatus) => void): () => void
  dispose(): void
}

// AI tools (bash, API calls) can pause 20-30s between chunks — don't mark blocked too early
export const BLOCKED_TIMEOUT_MS = 30_000
// After going blocked, auto-return to idle if still no output (agent probably done)
export const IDLE_AFTER_BLOCKED_MS = 90_000

export function createAgentStatusTracker(): AgentStatusTracker {
  let status: AgentStatus = 'idle'
  let listeners: Array<(s: AgentStatus) => void> = []
  let blockedTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const emit = (next: AgentStatus) => {
    if (next === status) return
    status = next
    listeners.forEach(cb => cb(status))
  }

  const clearTimers = () => {
    if (blockedTimer !== undefined) { clearTimeout(blockedTimer); blockedTimer = undefined }
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
  }

  const scheduleInactivity = () => {
    clearTimers()
    blockedTimer = setTimeout(() => {
      emit('blocked')
      idleTimer = setTimeout(() => emit('idle'), IDLE_AFTER_BLOCKED_MS)
    }, BLOCKED_TIMEOUT_MS)
  }

  return {
    onCommandStart() {
      emit('working')
      scheduleInactivity()
    },
    onCommandEnd() {
      clearTimers()
      emit('idle')
    },
    // Any PTY output activates the tracker — works with or without OSC 133 shell
    // integration. Without OSC 133, output is the only signal we have.
    onOutput() {
      emit('working')
      scheduleInactivity()
    },
    onChange(cb) {
      listeners.push(cb)
      return () => { listeners = listeners.filter(l => l !== cb) }
    },
    dispose() {
      clearTimers()
      listeners = []
    },
  }
}
