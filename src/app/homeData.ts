// Pure helpers for the home cockpit's "resume" data. Kept out of the DOM view so
// they can be unit-tested.

export interface RecentAgent {
  name: string
  cwd?: string
  cmd?: string
  sessionId?: string
}

// An agent is resumable only if it actually ran an agent CLI (`cmd`) AND captured
// a session (`sessionId`). A bare terminal, or an agent that never started a
// conversation, has nothing to resume — don't offer it.
export function resumableAgents(saved: unknown): RecentAgent[] {
  if (!Array.isArray(saved)) return []
  return saved.filter((a): a is RecentAgent => {
    if (!a || typeof a !== 'object') return false
    const agent = a as Record<string, unknown>
    return typeof agent.name === 'string'
      && typeof agent.cmd === 'string' && agent.cmd.length > 0
      && typeof agent.sessionId === 'string' && agent.sessionId.length > 0
  })
}

// Unique project folders from the given agents, most-recent order preserved.
export function recentProjects(agents: RecentAgent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const agent of agents) {
    const cwd = agent.cwd?.trim()
    if (!cwd || seen.has(cwd)) continue
    seen.add(cwd)
    out.push(cwd)
  }
  return out
}
