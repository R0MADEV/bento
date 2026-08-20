import type { AgentStatus } from './agentStatusTracker'

export const AGENT_SESSIONS_KEY = 'bento.agents.sessions'
export const AGENT_DOCK_EVENT = 'bento:agents-dock'
// Fired when a dock chip is clicked: asks the live agents panel to focus the
// agent with this pty id, so clicking a chip jumps to that exact agent.
export const AGENT_ACTIVATE_EVENT = 'bento:agents-activate'

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

export function emitAgentDock(entries: AgentDockEntry[]): void {
  window.dispatchEvent(new CustomEvent<AgentDockEntry[]>(AGENT_DOCK_EVENT, { detail: entries }))
}

export function emitAgentActivate(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(AGENT_ACTIVATE_EVENT, { detail: id }))
}
