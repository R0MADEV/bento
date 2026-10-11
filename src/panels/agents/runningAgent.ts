import { toDisplayPath } from '../../core/terminal/osc7'

// What the daemon sees running in an agent's terminal (`pty_agent`): which
// agent, on which session and with which Claude account. It's read from the
// process, so it's right however the agent was launched.
export interface RunningAgent {
  agent: string
  sessionId: string | null
  configDir: string | null
  cwd: string | null
}

export interface AgentIdentity {
  cmd?: string
  sessionId?: string
  configDir?: string
  // Folder the agent was launched from, not the one the terminal was born in.
  cwd?: string
}

// Folds what's running into the slot. Returns whether anything changed.
// The shell alone (null) keeps the last agent, so it is still resumed after a
// restart; a session the probe can't see (OpenCode's, found on disk) is kept.
export function applyRunningAgent(slot: AgentIdentity, running: RunningAgent | null): boolean {
  if (!running) return false
  const sessionId = running.sessionId ?? undefined
  const configDir = running.configDir ?? undefined
  const cwd = running.cwd ?? undefined
  if (running.agent !== slot.cmd) {
    slot.cmd = running.agent
    slot.sessionId = sessionId
    slot.configDir = configDir
    slot.cwd = cwd ?? slot.cwd
    return true
  }
  const isNewSession = sessionId !== undefined && sessionId !== slot.sessionId
  const isNewAccount = configDir !== slot.configDir
  const isNewFolder = cwd !== undefined && cwd !== slot.cwd
  const isUnchanged = !isNewSession && !isNewAccount && !isNewFolder
  if (isUnchanged) return false
  if (isNewSession) slot.sessionId = sessionId
  if (isNewFolder) slot.cwd = cwd
  slot.configDir = configDir
  return true
}

// What the sidebar shows under an agent's name: its folder and, inside a
// repository, the branch it is on.
export function agentLocation(cwd: string, branch?: string): string {
  const folder = toDisplayPath(cwd)
  return branch ? `${folder} · ${branch}` : folder
}
