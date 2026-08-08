import type { AgentStatus } from './agentStatusTracker'

export interface AgentEntry {
  readonly id: string
  readonly title: string
  readonly status: AgentStatus
  readonly statusSince: number
}

export interface AgentStore {
  register(id: string, initialTitle: string): void
  unregister(id: string): void
  setTitle(id: string, title: string): void
  setStatus(id: string, status: AgentStatus): void
  onChange(cb: (entries: ReadonlyArray<AgentEntry>) => void): () => void
  getAll(): ReadonlyArray<AgentEntry>
}

export function createAgentStore(): AgentStore {
  const entries = new Map<string, AgentEntry>()
  const listeners = new Set<(entries: ReadonlyArray<AgentEntry>) => void>()

  const snapshot = (): ReadonlyArray<AgentEntry> => [...entries.values()]
  const emit = () => { const s = snapshot(); listeners.forEach(cb => cb(s)) }

  return {
    register(id, initialTitle) {
      entries.set(id, { id, title: initialTitle, status: 'idle', statusSince: Date.now() })
      emit()
    },
    unregister(id) {
      entries.delete(id)
      emit()
    },
    setTitle(id, title) {
      const entry = entries.get(id)
      if (!entry || entry.title === title) return
      entries.set(id, { ...entry, title })
      emit()
    },
    setStatus(id, status) {
      const entry = entries.get(id)
      if (!entry || entry.status === status) return
      entries.set(id, { ...entry, status, statusSince: Date.now() })
      emit()
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getAll: snapshot,
  }
}
