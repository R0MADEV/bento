// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { makeLocalStorage } from '../../helpers/localStorage'
import { buildAiChatConversations } from '../../../src/ui/aiChat/conversations'
import { emptyChatHistory, GLOBAL_CHAT_CONVERSATION } from '../../../src/core/ai/chatHistory'
import { loadConfig } from '../../../src/core/ai/config'
import type { AiChatDom } from '../../../src/ui/aiChat/dom'
import type { ChatMessage } from '../../../src/core/ai/config'

function setup() {
  const dom = {
    list: document.createElement('div'),
    historySelect: document.createElement('select'),
    historyRefreshBtn: Object.assign(document.createElement('button'), { title: '' }),
    agentSelect: (() => {
      const select = document.createElement('select')
      for (const value of ['claude', 'codex', 'opencode']) {
        select.append(Object.assign(document.createElement('option'), { value, textContent: value }))
      }
      return select
    })(),
    modeBadge: document.createElement('span'),
    reviewAgentBadge: document.createElement('span'),
  } as unknown as AiChatDom

  const history = emptyChatHistory()
  let activeKey = GLOBAL_CHAT_CONVERSATION
  const messages: ChatMessage[] = []
  let config = loadConfig()
  const resetSession = vi.fn()
  const applyConfigToUi = vi.fn()

  const api = buildAiChatConversations(dom, {
    history: () => history,
    activeKey: () => activeKey,
    setActiveKey: key => { activeKey = key },
    messages: () => messages,
    setMessages: next => { messages.splice(0, messages.length, ...next) },
    pending: () => null,
    config: () => config,
    setConfig: next => { config = next },
    renderThread: vi.fn(),
    applyConfigToUi,
    resetSession,
  })
  return { api, dom, history, messages, resetSession, applyConfigToUi, activeKey: () => activeKey }
}

describe('aiChat conversations', () => {
  beforeEach(() => {
    globalThis.localStorage = makeLocalStorage() as unknown as Storage
    localStorage.setItem('bento.locale', 'en')
    mocks.invoke.mockClear()
  })

  it('labels a review conversation with its title', () => {
    const { api, history } = setup()
    history.contexts['tech-review:/work/repo:feat/a'] = { projectPath: '/work/repo', title: 'repo · feat/a', agentType: 'claude' } as never
    expect(api.conversationLabel('tech-review:/work/repo:feat/a')).toBe('repo · feat/a')
  })

  it('falls back to the project folder when there is no title', () => {
    const { api, history } = setup()
    history.contexts['k'] = { projectPath: '/work/mi-repo/', agentType: 'claude' } as never
    expect(api.conversationLabel('k')).toBe('mi-repo')
  })

  it('locks the agent selector inside a review conversation', () => {
    const { api, dom, history } = setup()
    history.contexts[GLOBAL_CHAT_CONVERSATION] = { projectPath: '/x', branch: 'feat/a', agentType: 'claude' } as never
    api.syncAgentSelectionState()
    expect(dom.agentSelect.disabled).toBe(true)
    expect(dom.reviewAgentBadge.classList.contains('hidden')).toBe(false)
  })

  it('leaves it free in the general chat', () => {
    const { api, dom } = setup()
    api.syncAgentSelectionState()
    expect(dom.agentSelect.disabled).toBe(false)
  })

  it('saves the visible messages under the active conversation', async () => {
    const { api, history, messages } = setup()
    messages.push({ role: 'user', content: 'hola' })
    api.persistHistory()
    await Promise.resolve()
    expect(history.conversations[GLOBAL_CHAT_CONVERSATION]).toHaveLength(1)
    expect(mocks.invoke).toHaveBeenCalledWith('chat_history_save', expect.anything())
  })

  it('switching conversation drops the agent session of the previous one', () => {
    // Reanudar la sesión anterior en otra conversación mezclaría dos hilos.
    const { api, history, resetSession, activeKey } = setup()
    history.conversations['otra'] = [{ role: 'user', content: 'previo' }]
    api.switchConversation('otra')
    expect(activeKey()).toBe('otra')
    expect(resetSession).toHaveBeenCalled()
  })

  it('switching into a review adopts its project and agent', () => {
    const { api, history, dom, applyConfigToUi } = setup()
    history.conversations['review'] = []
    history.contexts['review'] = { projectPath: '/work/repo', branch: 'feat/a', agentType: 'codex' } as never
    api.switchConversation('review')
    expect(dom.agentSelect.value).toBe('codex')
    expect(applyConfigToUi).toHaveBeenCalled()
  })

  it('ignores a switch to the conversation already open', async () => {
    const { api } = setup()
    api.switchConversation(GLOBAL_CHAT_CONVERSATION)
    await Promise.resolve()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('lists every conversation in the selector, marking the active one', () => {
    const { api, dom, history } = setup()
    history.conversations['otra'] = []
    api.refreshHistorySelect()
    expect(dom.historySelect.options).toHaveLength(2)
    expect(dom.historySelect.value).toBe(GLOBAL_CHAT_CONVERSATION)
  })
})
