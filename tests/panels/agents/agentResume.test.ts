import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildResumeCmd } from '../../../src/panels/agents/agentResume'

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(null)
})

// The rules (which session is still on disk, in which folder and account it
// resumes) live in `bento_sessions::resume_line_for_shell`, shared with the daemon, so
// the app brings an agent back exactly as the CLI and the phone do.
describe('buildResumeCmd', () => {
  it('types the line the shared rules give for the agent', async () => {
    mocks.invoke.mockResolvedValue(`cd '/repo/app' && claude --resume s1`)
    expect(await buildResumeCmd('claude', '/repo', 's1', '/Users/x/.claude-pro')).toBe(`cd '/repo/app' && claude --resume s1`)
    expect(mocks.invoke).toHaveBeenCalledWith('agent_resume_line', {
      agent: 'claude', cwd: '/repo', sessionId: 's1', configDir: '/Users/x/.claude-pro',
    })
  })

  // Aider, Gemini…: detected by the app, with no session to resume.
  it('starts an agent the rules do not cover by its own name', async () => {
    expect(await buildResumeCmd('aider', '/repo', 's1')).toBe('aider')
  })

  it('still starts the agent when the rules cannot be asked', async () => {
    mocks.invoke.mockRejectedValue(new Error('backend unreachable'))
    expect(await buildResumeCmd('claude', '/repo', 's1')).toBe('claude')
  })
})
