import type { AgentStatus } from './agentStatusTracker'

export const AGENT_SESSIONS_KEY = 'bento.agents.sessions'
export const AGENT_DOCK_EVENT = 'bento:agents-dock'

export type AgentAttention = 'blocked' | 'bell'

export interface AgentDockEntry {
  id: string
  name: string
  cwd: string
  cmd?: string
  status: AgentStatus
  attention?: AgentAttention
  active?: boolean
}

interface SavedAgentSession { name?: string; cwd?: string; cmd?: string }

export function savedAgentDockEntries(): AgentDockEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(AGENT_SESSIONS_KEY) ?? '[]') as SavedAgentSession[]
    if (!Array.isArray(saved)) return []
    return saved.map((agent, index) => ({
      id: `saved-${index}`,
      name: agent.name || `Agent ${index + 1}`,
      cwd: agent.cwd || '',
      cmd: agent.cmd,
      status: 'idle',
    }))
  } catch {
    return []
  }
}

export function emitAgentDock(entries: AgentDockEntry[]): void {
  window.dispatchEvent(new CustomEvent<AgentDockEntry[]>(AGENT_DOCK_EVENT, { detail: entries }))
}
