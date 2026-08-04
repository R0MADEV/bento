// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../helpers/localStorage'

const mocks = vi.hoisted(() => {
  let emitChunk: ((text: string) => void) | undefined
  let finish: (() => void) | undefined
  let loadedHistory = '[]'
  const startAgent = vi.fn((_params, onChunk: (text: string) => void, onDone: (sessionId: string | null) => void) => {
    let resolveCompleted!: () => void
    emitChunk = onChunk
    finish = () => { onDone('session-1'); resolveCompleted() }
    return {
      requestId: 'request-1',
      ready: Promise.resolve(),
      completed: new Promise<void>(resolve => { resolveCompleted = resolve }),
      cancel: vi.fn(async () => {}),
      unlisten: vi.fn(),
    }
  })
  const invoke = vi.fn(async (command: string) => command === 'chat_history_load' ? loadedHistory : undefined)
  return {
    invoke,
    startAgent,
    setLoadedHistory: (history: string) => { loadedHistory = history },
    emitChunk: (text: string) => emitChunk?.(text),
    finish: () => finish?.(),
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
      expect(latest.contexts['tech-review:/tmp/review-project:feat/review']).toEqual({ projectPath: '/tmp/review-project', agentType: 'claude' })
    })

    mocks.finish()
    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    expect(root.querySelector<HTMLButtonElement>('.ai-send')?.disabled).toBe(false)
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
        'tech-review:D:/work/repo:feat/review': { projectPath: 'D:\\work\\repo', agentType: 'codex' },
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
    expect(mocks.startAgent.mock.calls[0][0]).toMatchObject({ agent: 'codex', projectPath: 'D:\\work\\repo' })
    mocks.finish()
    await vi.waitFor(() => expect(root.classList.contains('busy')).toBe(false))
    root.remove()
  })
})
