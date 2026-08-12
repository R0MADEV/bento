import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler)
    return () => mocks.listeners.delete(event)
  }),
}))

import { buildContext, redact, truncateHistory, resolvePersistedSessionId, buildReviewMessage, type AgentParams } from '../../../src/core/ai/agentClient'
import { startAgent } from '../../../src/core/ai/agentClient'

describe('review session helpers', () => {
  const ctx = { branch: 'feat/x', commit: 'abc', sessionId: 's1', sessionAgent: 'claude', sessionCommit: 'abc' }

  it('reuses the persisted session only for the same agent and commit', () => {
    expect(resolvePersistedSessionId(ctx, 'claude')).toBe('s1')
  })
  it('starts fresh when the agent changed', () => {
    expect(resolvePersistedSessionId(ctx, 'codex')).toBeNull()
  })
  it('starts fresh when the commit changed', () => {
    expect(resolvePersistedSessionId({ ...ctx, sessionCommit: 'old' }, 'claude')).toBeNull()
  })
  it('returns null outside a review conversation', () => {
    expect(resolvePersistedSessionId({ commit: 'abc' }, 'claude')).toBeNull()
  })

  it('appends evidence to the message only on a fresh review session', () => {
    const msg = buildReviewMessage('hi', ['tool a', 'tool b'], false)
    expect(msg).toContain('hi')
    expect(msg).toContain('Persisted review evidence:')
    expect(msg).toContain('- tool a')
  })
  it('leaves the message untouched when resuming a session', () => {
    expect(buildReviewMessage('hi', ['tool a'], true)).toBe('hi')
  })
  it('leaves the message untouched when there is no evidence', () => {
    expect(buildReviewMessage('hi', [], false)).toBe('hi')
  })
})

const params = (overrides: Partial<AgentParams> = {}): AgentParams => ({
  agent: 'claude', message: 'hello', history: [], projectPath: '/tmp/project', ...overrides,
})

describe('Agent client context', () => {
  beforeEach(() => { mocks.listeners.clear(); mocks.invoke.mockClear() })
  it('redacts known secret formats', () => {
    expect(redact('sk-12345678901234567890')).toBe('[REDACTED]')
  })

  it('keeps the newest history within its budget', () => {
    const history = truncateHistory([
      { role: 'user', content: 'old'.repeat(10_000) },
      { role: 'user', content: 'new' },
    ], 10)
    expect(history).toEqual([{ role: 'user', content: 'new' }])
  })

  it('truncates combined context instead of exceeding the budget', () => {
    const result = buildContext(params({ message: 'm'.repeat(30_000), diff: 'd'.repeat(30_000) }))
    expect(result.message.length).toBeLessThanOrEqual(28_000)
    expect(result.message).toContain('[context truncated]')
  })

  it('cleans listeners after the terminal done event', async () => {
    const onDone = vi.fn()
    const handle = startAgent(params(), vi.fn(), onDone, vi.fn())
    await handle.ready
    const done = mocks.listeners.get(`agent://done:${handle.requestId}`)
    done?.({ payload: { session_id: 'session-1' } })
    await handle.completed
    expect(onDone).toHaveBeenCalledWith('session-1')
    expect(mocks.listeners.size).toBe(0)
  })

  it('does not start an agent when cancelled before ready', async () => {
    const handle = startAgent(params(), vi.fn(), vi.fn(), vi.fn())
    await handle.cancel()
    await handle.ready
    expect(mocks.invoke).not.toHaveBeenCalledWith('start_agent', expect.anything())
  })

  it('forwards managed project cleanup to the backend', async () => {
    const handle = startAgent(params({ cleanupProjectPath: true }), vi.fn(), vi.fn(), vi.fn())
    await handle.ready

    expect(mocks.invoke).toHaveBeenCalledWith('start_agent', {
      args: expect.objectContaining({ cleanup_project_path: true }),
    })
    mocks.listeners.get(`agent://done:${handle.requestId}`)?.({ payload: { session_id: null } })
    await handle.completed
  })
})
