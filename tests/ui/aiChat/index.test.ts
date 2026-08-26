// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => {
  let emitChunk: ((text: string) => void) | undefined
  let finish: (() => void) | undefined
  let fail: ((message: string) => void) | undefined
  let emitTool: ((tool: string) => void) | undefined
  let loadedHistory = '[]'
  const startAgent = vi.fn((_params, onChunk: (text: string) => void, onDone: (sessionId: string | null) => void, onError: (message: string) => void, onTool?: (tool: string) => void) => {
    let resolveCompleted!: () => void
    emitChunk = onChunk
    finish = () => { onDone('session-1'); resolveCompleted() }
    fail = message => { onError(message); resolveCompleted() }
    emitTool = tool => onTool?.(tool)
    return {
      requestId: 'request-1',
      ready: Promise.resolve(),
      completed: new Promise<void>(resolve => { resolveCompleted = resolve }),
      cancel: vi.fn(async () => {}),
      unlisten: vi.fn(),
    }
  })
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'chat_history_load') return loadedHistory
    if (command === 'agent_claude_session_exists' || command === 'agent_codex_session_exists') return true
    if (command === 'review_branch_context_prepare') {
      return {
        path: `/managed/${args?.reference}`,
        commit: args?.commit ?? '1111111111111111111111111111111111111111',
        latestCommit: '1111111111111111111111111111111111111111',
        managed: true,
        stale: false,
      }
    }
    if (command === 'review_branch_context_check') {
      return {
        path: `/managed/${args?.reference}`,
        commit: args?.commit,
        latestCommit: '2222222222222222222222222222222222222222',
        managed: true,
        stale: true,
      }
    }
    if (command === 'review_branch_context_update') {
      return {
        path: `/managed/${args?.reference}`,
        commit: '2222222222222222222222222222222222222222',
        latestCommit: '2222222222222222222222222222222222222222',
        managed: true,
        stale: false,
      }
    }
    return undefined
  })
  return {
    invoke,
    startAgent,
    setLoadedHistory: (history: string) => { loadedHistory = history },
    emitChunk: (text: string) => emitChunk?.(text),
    finish: () => finish?.(),
    fail: (message: string) => fail?.(message),
    emitTool: (tool: string) => emitTool?.(tool),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../src/adapters/aiKeys', () => ({
  getAiKey: vi.fn(async () => ''),
  setAiKey: vi.fn(async () => true),
  vaultStatus: vi.fn(async () => 'unlocked'),
}))
vi.mock('../../../src/adapters/agentRunner', () => ({ startAgent: mocks.startAgent }))
vi.mock('../../../src/core/ai/agentClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/ai/agentClient')>()),
  redact: (value: string) => value,
}))

import { createAiChat } from '../../../src/ui/aiChat/index'
import { AI_ASK_EVENT } from '../../../src/ui/askAi'
import type { MemoryRepository } from '../../../src/ports/MemoryRepository'

describe('AI chat agent follow-ups', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    mocks.setLoadedHistory('[]')
    mocks.invoke.mockClear()
    mocks.startAgent.mockClear()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('keeps listening until the follow-up agent finishes', async () => {
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    expect(root.querySelector('[data-testid="ai-mode-badge"]')?.textContent).toBe('Chat mode')
    window.dispatchEvent(new CustomEvent(AI_ASK_EVENT, { detail: {
      text: '',
      projectPath: '/tmp/review-project',
      agentType: 'claude',
      conversationKey: 'tech-review:/tmp/review-project:feat/review',
      conversationTitle: 'review-project · feat/review',
      conversationBranch: 'feat/review',
      conversationCommit: '1111111111111111111111111111111111111111',
      conversationSessionId: 'initial-review-session',
      conversationEvidence: ['Read: src/review.ts'],
      inject: { role: 'assistant', content: 'Initial review' },
    } }))

    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Initial review'), { timeout: 3_000 })
    expect(root.querySelector<HTMLSelectElement>('.ai-agent-select')?.disabled).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-testid="ai-review-agent"]')?.textContent).toBe('Fixed agent: Claude')
    expect(root.querySelector('[data-testid="ai-mode-badge"]')?.textContent).toBe('Agent mode')
    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Explain the first finding'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()

    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())
    expect(root.classList.contains('busy')).toBe(true)
    expect(root.querySelector('.ai-msg-pending')?.textContent).toContain('working')
    expect(root.querySelector<HTMLButtonElement>('.ai-send')?.disabled).toBe(true)
    mocks.emitTool('Grep: createReview')
    mocks.emitChunk('Follow-up response')
    expect(root.querySelector('.ai-thread')?.textContent).toContain('Follow-up response')
    expect(root.querySelector('.ai-msg-pending')).toBeNull()
    await vi.waitFor(() => {
      const saves = mocks.invoke.mock.calls.filter(([command]) => command === 'chat_history_save')
      const latest = JSON.parse(saves.at(-1)?.[1]?.content as string)
      expect(latest.conversations['tech-review:/tmp/review-project:feat/review']).toContainEqual({ role: 'assistant', content: 'Follow-up response' })
      expect(latest.contexts['tech-review:/tmp/review-project:feat/review']).toEqual({
        projectPath: '/tmp/review-project',
        agentType: 'claude',
        title: 'review-project · feat/review',
        branch: 'feat/review',
        commit: '1111111111111111111111111111111111111111',
        sessionId: 'initial-review-session',
        sessionAgent: 'claude',
        sessionCommit: '1111111111111111111111111111111111111111',
        evidence: ['Read: src/review.ts', 'Grep: createReview'],
        worktreePath: '/managed/feat/review',
      })
    })

    mocks.finish()
    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    await vi.waitFor(() => {
      const saves = mocks.invoke.mock.calls.filter(([command]) => command === 'chat_history_save')
      const latest = JSON.parse(saves.at(-1)?.[1]?.content as string)
      expect(latest.contexts['tech-review:/tmp/review-project:feat/review']).toMatchObject({
        sessionId: 'session-1',
        sessionAgent: 'claude',
        sessionCommit: '1111111111111111111111111111111111111111',
      })
      expect(latest.contexts['tech-review:/tmp/review-project:feat/review']).not.toHaveProperty('worktreePath')
    })
    expect(root.querySelector<HTMLButtonElement>('.ai-send')?.disabled).toBe(false)
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({
      projectPath: '/managed/feat/review',
      review: true,
      cleanupProjectPath: true,
      sessionId: 'initial-review-session',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_release', {
      path: '/managed/feat/review',
    })
    root.remove()
  })

  it('does not resume a review session with a different agent', async () => {
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    window.dispatchEvent(new CustomEvent(AI_ASK_EVENT, { detail: {
      text: '',
      projectPath: '/tmp/review-project',
      agentType: 'codex',
      conversationKey: 'tech-review:/tmp/review-project:feat/review',
      conversationTitle: 'review-project · feat/review',
      conversationBranch: 'feat/review',
      conversationCommit: '1111111111111111111111111111111111111111',
      conversationSessionId: 'claude-session',
      conversationSessionAgent: 'claude',
      inject: { role: 'assistant', content: 'Initial review' },
    } }))

    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Initial review'), { timeout: 3_000 })
    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Continue with this review'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()

    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({
      agent: 'codex',
      sessionId: null,
      review: true,
    })
    root.remove()
  })

  it('resumes a persisted Tech Review conversation after reopening Bento', async () => {
    mocks.setLoadedHistory(JSON.stringify({
      version: 2,
      activeConversation: 'tech-review:D:/work/repo:feat/review',
      conversations: {
        'tech-review:D:/work/repo:feat/review': [{ role: 'assistant', content: 'Persisted review' }],
      },
      contexts: {
        'tech-review:D:/work/repo:feat/review': {
          projectPath: 'D:\\work\\repo',
          agentType: 'codex',
          title: 'repo · feat/review',
          branch: 'feat/review',
          commit: '1111111111111111111111111111111111111111',
          sessionId: 'persisted-codex-session',
          sessionAgent: 'codex',
          sessionCommit: '1111111111111111111111111111111111111111',
          evidence: ['Read: src/main.rs'],
        },
      },
    }))
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Persisted review'))
    expect(root.querySelector<HTMLSelectElement>('.ai-agent-select')?.disabled).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-testid="ai-review-agent"]')?.textContent).toBe('Fixed agent: Codex')
    expect(root.querySelector('[data-testid="ai-mode-badge"]')?.textContent).toBe('Agent mode')

    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Continue this review'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()

    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({
      agent: 'codex',
      projectPath: '/managed/feat/review',
      review: true,
      sessionId: 'persisted-codex-session',
      message: 'Continue this review',
    })
    mocks.finish()
    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    root.remove()
  })

  it('requests managed worktree cleanup when an agent follow-up fails', async () => {
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    window.dispatchEvent(new CustomEvent(AI_ASK_EVENT, { detail: {
      text: '',
      projectPath: '/tmp/review-project',
      agentType: 'codex',
      conversationKey: 'tech-review:/tmp/review-project:origin/feat/failure',
      conversationTitle: 'review-project · origin/feat/failure',
      conversationBranch: 'origin/feat/failure',
      conversationCommit: '1111111111111111111111111111111111111111',
      inject: { role: 'assistant', content: 'Initial review' },
    } }))
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Initial review'))

    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Continue after this review'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()
    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())
    mocks.fail('agent failed')

    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    expect(root.querySelector('.ai-thread')?.textContent).toContain('agent failed')
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({ cleanupProjectPath: true })
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_release', {
      path: '/managed/origin/feat/failure',
    })
    root.remove()
  })

  it('queues a new Tech Review until the active response is saved to its original branch', async () => {
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    window.dispatchEvent(new CustomEvent(AI_ASK_EVENT, { detail: {
      text: '',
      projectPath: '/work/repo',
      agentType: 'claude',
      conversationKey: 'tech-review:/work/repo:feat/one',
      conversationTitle: 'repo · feat/one',
      conversationBranch: 'feat/one',
      conversationCommit: '1111111111111111111111111111111111111111',
      inject: { role: 'assistant', content: 'Review for branch one' },
    } }))
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Review for branch one'))

    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Analyze branch one further'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()
    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())

    window.dispatchEvent(new CustomEvent(AI_ASK_EVENT, { detail: {
      text: '',
      projectPath: '/work/repo',
      agentType: 'codex',
      conversationKey: 'tech-review:/work/repo:feat/two',
      conversationTitle: 'repo · feat/two',
      conversationBranch: 'feat/two',
      conversationCommit: '2222222222222222222222222222222222222222',
      inject: { role: 'assistant', content: 'Review for branch two' },
    } }))
    await Promise.resolve()
    expect(root.querySelector('.ai-thread')?.textContent).toContain('Review for branch one')
    expect(root.querySelector('.ai-thread')?.textContent).not.toContain('Review for branch two')

    mocks.emitChunk('Completed analysis for branch one')
    mocks.finish()
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Review for branch two'))

    const history = root.querySelector<HTMLSelectElement>('[data-testid="ai-history-select"]')!
    history.value = 'tech-review:/work/repo:feat/one'
    history.dispatchEvent(new Event('change'))
    expect(root.querySelector('.ai-thread')?.textContent).toContain('Completed analysis for branch one')
    expect(root.querySelector('.ai-thread')?.textContent).not.toContain('Review for branch two')
    input.value = 'Resume branch one'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()
    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledTimes(2))
    expect(mocks.startAgent.mock.calls[1][0]).toMatchObject({ sessionId: 'session-1' })
    mocks.finish()
    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    expect(mocks.invoke.mock.calls.some(([command, args]) => command === 'review_branch_context_release' && (args as { path?: string }).path === '/managed/feat/one')).toBe(true)
    root.remove()
  })

  it('switches between persisted branch reviews and deletes only the selected conversation', async () => {
    mocks.setLoadedHistory(JSON.stringify({
      version: 2,
      activeConversation: 'tech-review:/work/repo:feat/two',
      conversations: {
        global: [{ role: 'user', content: 'General question' }],
        'tech-review:/work/repo:feat/one': [{ role: 'assistant', content: 'Review for branch one' }],
        'tech-review:/work/repo:feat/two': [{ role: 'assistant', content: 'Review for branch two' }],
      },
      contexts: {
        'tech-review:/work/repo:feat/one': { projectPath: '/work/repo', agentType: 'claude', title: 'repo · feat/one', branch: 'feat/one', commit: '1111111111111111111111111111111111111111' },
        'tech-review:/work/repo:feat/two': { projectPath: '/work/repo', agentType: 'codex', title: 'repo · feat/two', branch: 'feat/two', commit: '1111111111111111111111111111111111111111' },
      },
    }))
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Review for branch two'))

    const history = root.querySelector<HTMLSelectElement>('[data-testid="ai-history-select"]')!
    expect(Array.from(history.options).map(option => option.textContent)).toEqual([
      'General chat',
      'repo · feat/one',
      'repo · feat/two',
    ])

    history.value = 'tech-review:/work/repo:feat/one'
    history.dispatchEvent(new Event('change'))
    expect(root.querySelector('.ai-thread')?.textContent).toContain('Review for branch one')
    expect(root.querySelector('.ai-thread')?.textContent).not.toContain('Review for branch two')
    expect(mocks.startAgent).not.toHaveBeenCalled()

    root.querySelector<HTMLButtonElement>('[data-testid="ai-history-delete"]')!.click()
    expect(Array.from(history.options).map(option => option.textContent)).toEqual([
      'General chat',
      'repo · feat/two',
    ])
    expect(root.querySelector('.ai-thread')?.textContent).toContain('Review for branch two')

    await vi.waitFor(() => {
      const saves = mocks.invoke.mock.calls.filter(([command]) => command === 'chat_history_save')
      const latest = JSON.parse(saves.at(-1)?.[1]?.content as string)
      expect(latest.conversations['tech-review:/work/repo:feat/one']).toBeUndefined()
      expect(latest.conversations['tech-review:/work/repo:feat/two']).toHaveLength(1)
    })
    expect(mocks.invoke.mock.calls.some(([command, args]) => command === 'review_branch_context_release' && (args as { path?: string }).path === '/work/repo')).toBe(true)
    root.remove()
  })

  it('fetches and updates a review conversation to a newer branch commit', async () => {
    mocks.setLoadedHistory(JSON.stringify({
      version: 2,
      activeConversation: 'tech-review:/work/repo:origin/feat/review',
      conversations: {
        'tech-review:/work/repo:origin/feat/review': [{ role: 'assistant', content: 'Original review' }],
      },
      contexts: {
        'tech-review:/work/repo:origin/feat/review': {
          projectPath: '/work/repo',
          agentType: 'codex',
          title: 'repo · origin/feat/review',
          branch: 'origin/feat/review',
          commit: '1111111111111111111111111111111111111111',
          sessionId: 'old-session',
          sessionAgent: 'codex',
          sessionCommit: '1111111111111111111111111111111111111111',
          evidence: ['Read: old.ts'],
        },
      },
    }))
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Original review'))

    root.querySelector<HTMLButtonElement>('[data-testid="ai-history-refresh"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('2222222'))
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_check', {
      repoPath: '/work/repo',
      reference: 'origin/feat/review',
      commit: '1111111111111111111111111111111111111111',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_update', {
      repoPath: '/work/repo',
      reference: 'origin/feat/review',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_release', {
      path: '/managed/origin/feat/review',
    })
    await vi.waitFor(() => {
      const saves = mocks.invoke.mock.calls.filter(([command]) => command === 'chat_history_save')
      const latest = JSON.parse(saves.at(-1)?.[1]?.content as string)
      const context = latest.contexts['tech-review:/work/repo:origin/feat/review']
      expect(context.commit).toBe('2222222222222222222222222222222222222222')
      expect(context.sessionId).toBeUndefined()
      expect(context.sessionAgent).toBeUndefined()
      expect(context.sessionCommit).toBeUndefined()
      expect(context.evidence).toEqual([])
    })
    root.remove()
  })
})
