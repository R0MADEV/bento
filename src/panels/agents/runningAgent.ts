// What the daemon sees running in an agent's terminal (`pty_agent`): which
// agent, on which session and with which Claude account. It's read from the
// process, so it's right however the agent was launched.
export interface RunningAgent {
  agent: string
  sessionId: string | null
  configDir: string | null
}

export interface AgentIdentity {
  cmd?: string
  sessionId?: string
  configDir?: string
}

// Folds what's running into the slot. Returns whether anything changed.
// The shell alone (null) keeps the last agent, so it is still resumed after a
// restart; a session the probe can't see (OpenCode's, found on disk) is kept.
export function applyRunningAgent(slot: AgentIdentity, running: RunningAgent | null): boolean {
  if (!running) return false
  const sessionId = running.sessionId ?? undefined
  const configDir = running.configDir ?? undefined
  if (running.agent !== slot.cmd) {
    slot.cmd = running.agent
    slot.sessionId = sessionId
    slot.configDir = configDir
    return true
  }
  const isNewSession = sessionId !== undefined && sessionId !== slot.sessionId
  const isNewAccount = configDir !== slot.configDir
  if (!isNewSession && !isNewAccount) return false
  if (isNewSession) slot.sessionId = sessionId
  slot.configDir = configDir
  return true
}
