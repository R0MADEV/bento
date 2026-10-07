import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildResumeCmd } from '../../../src/panels/agents/agentResume'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('claude', () => {
  it('launches plain when there is no session to resume', async () => {
    expect(await buildResumeCmd('claude', '/repo')).toBe('claude')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('resumes when the session still exists on disk', async () => {
    mocks.invoke.mockResolvedValue(true)
    expect(await buildResumeCmd('claude', '/repo', 's1')).toBe('claude --resume s1')
    expect(mocks.invoke).toHaveBeenCalledWith('agent_claude_session_exists', { cwd: '/repo', sessionId: 's1' })
  })

  it('falls back to a plain launch when the session is gone', async () => {
    mocks.invoke.mockResolvedValue(false)
    expect(await buildResumeCmd('claude', '/repo', 's1')).toBe('claude')
  })

  it('falls back to a plain launch when the check itself fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('daemon unreachable'))
    expect(await buildResumeCmd('claude', '/repo', 's1')).toBe('claude')
  })

  // Launched through an alias like `CLAUDE_CONFIG_DIR=~/.claude-pro claude`:
  // the session lives in that account, so it must resume in it too.
  it('resumes in the account it ran with', async () => {
    mocks.invoke.mockResolvedValue(true)
    expect(await buildResumeCmd('claude', '/repo', 's1', '/Users/x/.claude-pro'))
      .toBe(`CLAUDE_CONFIG_DIR='/Users/x/.claude-pro' claude --resume s1`)
    expect(mocks.invoke).toHaveBeenCalledWith('agent_claude_session_exists', { cwd: '/repo', sessionId: 's1', configDir: '/Users/x/.claude-pro' })
  })

  it('keeps the account on a plain launch', async () => {
    expect(await buildResumeCmd('claude', '/repo', undefined, '/Users/x/.claude-max'))
      .toBe(`CLAUDE_CONFIG_DIR='/Users/x/.claude-max' claude`)
  })

  it('quotes the account dir for the shell', async () => {
    expect(await buildResumeCmd('claude', '/repo', undefined, `/tmp/it's here`))
      .toBe(`CLAUDE_CONFIG_DIR='/tmp/it'\\''s here' claude`)
  })
})

describe('opencode', () => {
  it('resumes without checking whether the session exists', async () => {
    expect(await buildResumeCmd('opencode', '/repo', 's1')).toBe('opencode --session s1')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('launches plain with no session', async () => {
    expect(await buildResumeCmd('opencode', '/repo')).toBe('opencode')
  })
})

describe('codex', () => {
  it('resumes and clears the stale writer lock when the session exists', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => cmd === 'agent_codex_session_exists')
    expect(await buildResumeCmd('codex', '/repo', 's1')).toBe('codex resume s1')
    expect(mocks.invoke).toHaveBeenCalledWith('agent_codex_clear_lock', { sessionId: 's1' })
  })

  it('launches plain, and never clears the lock, when the session is gone', async () => {
    mocks.invoke.mockResolvedValue(false)
    expect(await buildResumeCmd('codex', '/repo', 's1')).toBe('codex')
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not fail the launch when clearing the lock errors', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_codex_session_exists') return true
      throw new Error('lock already gone')
    })
    expect(await buildResumeCmd('codex', '/repo', 's1')).toBe('codex resume s1')
  })

  it('launches plain with no session, without checking anything', async () => {
    expect(await buildResumeCmd('codex', '/repo')).toBe('codex')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('an unknown command', () => {
  it('is returned unchanged, session id or not', async () => {
    expect(await buildResumeCmd('aider', '/repo')).toBe('aider')
    expect(await buildResumeCmd('aider', '/repo', 's1')).toBe('aider')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
