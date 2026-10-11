import { describe, expect, it } from 'vitest'
import { agentLocation, applyRunningAgent, type AgentIdentity } from '../../../src/panels/agents/runningAgent'

const claude = { agent: 'claude', sessionId: 's1', configDir: '/Users/x/.claude-pro', cwd: null }

describe('applyRunningAgent', () => {
  it('keeps what it knew while the terminal is just the shell', () => {
    const slot: AgentIdentity = { cmd: 'claude', sessionId: 's1' }
    expect(applyRunningAgent(slot, null)).toBe(false)
    expect(slot).toEqual({ cmd: 'claude', sessionId: 's1' })
  })

  it('adopts an agent it never saw typed (alias, history, autocomplete)', () => {
    const slot: AgentIdentity = {}
    expect(applyRunningAgent(slot, claude)).toBe(true)
    expect(slot).toEqual({ cmd: 'claude', sessionId: 's1', configDir: '/Users/x/.claude-pro' })
  })

  it('follows the agent when another one is launched in the same terminal', () => {
    const slot: AgentIdentity = { cmd: 'claude', sessionId: 's1', configDir: '/Users/x/.claude-pro' }
    expect(applyRunningAgent(slot, { agent: 'opencode', sessionId: null, configDir: null, cwd: null })).toBe(true)
    expect(slot).toEqual({ cmd: 'opencode', sessionId: undefined, configDir: undefined })
  })

  it('follows a new session of the same agent (/clear, /resume)', () => {
    const slot: AgentIdentity = { cmd: 'claude', sessionId: 's1', configDir: '/Users/x/.claude-pro' }
    expect(applyRunningAgent(slot, { ...claude, sessionId: 's2' })).toBe(true)
    expect(slot.sessionId).toBe('s2')
  })

  // OpenCode's session is found on disk, not by the probe: don't drop it.
  it('keeps a captured session the probe cannot see', () => {
    const slot: AgentIdentity = { cmd: 'opencode', sessionId: 'ses_1' }
    expect(applyRunningAgent(slot, { agent: 'opencode', sessionId: null, configDir: null, cwd: null })).toBe(false)
    expect(slot.sessionId).toBe('ses_1')
  })

  // The folder the agent was launched from, not the one the terminal was born in.
  it('records the folder the agent runs in', () => {
    const slot: AgentIdentity = {}
    expect(applyRunningAgent(slot, { ...claude, cwd: '/Users/x/repo' })).toBe(true)
    expect(slot.cwd).toBe('/Users/x/repo')
  })

  it('keeps the folder when the probe cannot read it', () => {
    const slot: AgentIdentity = { cmd: 'claude', sessionId: 's1', configDir: '/Users/x/.claude-pro', cwd: '/Users/x/repo' }
    expect(applyRunningAgent(slot, claude)).toBe(false)
    expect(slot.cwd).toBe('/Users/x/repo')
  })

  it('reports no change when nothing changed', () => {
    const slot: AgentIdentity = { cmd: 'claude', sessionId: 's1', configDir: '/Users/x/.claude-pro' }
    expect(applyRunningAgent(slot, claude)).toBe(false)
  })
})

describe('agentLocation', () => {
  it('shows the folder and the branch it is on', () => {
    expect(agentLocation('/Users/x/Desktop/repo', 'feat/login')).toBe('~/Desktop/repo · feat/login')
  })

  it('shows only the folder outside a repository', () => {
    expect(agentLocation('/Users/x/Desktop/notes', '')).toBe('~/Desktop/notes')
    expect(agentLocation('/Users/x/Desktop/notes')).toBe('~/Desktop/notes')
  })
})
