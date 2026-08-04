// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../helpers/localStorage'

const mocks = vi.hoisted(() => {
  let emitChunk: ((text: string) => void) | undefined
  let finish: (() => void) | undefined
  let fail: ((message: string) => void) | undefined
  let loadedHistory = '[]'
  const startAgent = vi.fn((_params, onChunk: (text: string) => void, onDone: (sessionId: string | null) => void, onError: (message: string) => void) => {
    let resolveCompleted!: () => void
    emitChunk = onChunk
    finish = () => { onDone('session-1'); resolveCompleted() }
    fail = message => { onError(message); resolveCompleted() }
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
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../src/ui/aiKeys', () => ({
  getAiKey: vi.fn(async () => ''),
  setAiKey: vi.fn(async () => true),
  vaultStatus: vi.fn(async () => 'unlocked'),
}))
vi.mock('../../src/core/ai/agentClient', () => ({ startAgent: mocks.startAgent }))

import { createAiChat } from '../../src/ui/aiChat'
import { AI_ASK_EVENT } from '../../src/ui/askAi'
import type { MemoryRepository } from '../../src/ports/MemoryRepository'

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
    window.dispatchEvent(new CustomEvent(AI_ASK_EVENT, { detail: {
      text: '',
      projectPath: '/tmp/review-project',
      agentType: 'claude',
      conversationKey: 'tech-review:/tmp/review-project:feat/review',
      conversationTitle: 'review-project · feat/review',
      conversationBranch: 'feat/review',
      conversationCommit: '1111111111111111111111111111111111111111',
      inject: { role: 'assistant', content: 'Initial review' },
    } }))

    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Initial review'))
    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Explain the first finding'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()

    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())
    expect(root.classList.contains('busy')).toBe(true)
    expect(root.querySelector('.ai-msg-pending')?.textContent).toContain('working')
    expect(root.querySelector<HTMLButtonElement>('.ai-send')?.disabled).toBe(true)
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
      })
    })

    mocks.finish()
    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    expect(root.querySelector<HTMLButtonElement>('.ai-send')?.disabled).toBe(false)
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({
      projectPath: '/managed/feat/review',
      review: true,
      cleanupProjectPath: true,
    })
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_release', {
      repoPath: '/tmp/review-project',
      reference: 'feat/review',
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
        },
      },
    }))
    const memoryRepo = { list: vi.fn(async () => []) } as unknown as MemoryRepository
    const root = createAiChat(memoryRepo)
    document.body.appendChild(root)
    await vi.waitFor(() => expect(root.querySelector('.ai-thread')?.textContent).toContain('Persisted review'))

    const input = root.querySelector<HTMLTextAreaElement>('.ai-input')!
    input.value = 'Continue this review'
    root.querySelector<HTMLButtonElement>('.ai-send')!.click()

    await vi.waitFor(() => expect(mocks.startAgent).toHaveBeenCalledOnce())
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({ agent: 'codex', projectPath: '/managed/feat/review', review: true })
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
      repoPath: '/tmp/review-project',
      reference: 'origin/feat/failure',
    })
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
    expect(mocks.invoke).toHaveBeenCalledWith('review_branch_context_release', {
      repoPath: '/work/repo',
      reference: 'feat/one',
    })
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
      repoPath: '/work/repo',
      reference: 'origin/feat/review',
    })
    root.remove()
  })
})
