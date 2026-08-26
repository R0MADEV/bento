import { invoke } from '@tauri-apps/api/core'
import { t as i18nT } from '../../i18n'
import { agentLabel, toAgentType, type AiConfig, type ChatMessage } from '../../core/ai/config'
import { AGENT_PROVIDER_ID } from '../../core/ai/providers'
import { GLOBAL_CHAT_CONVERSATION, serializeChatHistory, type ChatHistoryState } from '../../core/ai/chatHistory'
import { setActiveProjectPath } from '../state/activeProject'
import type { AiChatDom } from './dom'

// Las conversaciones guardadas: cómo se llaman, cuál está activa, cuándo se
// escriben a disco y qué pasa al cambiar de una a otra (que incluye adoptar su
// proyecto y su agente, porque una review está atada a los suyos).

const MAX_HISTORY = 200

export interface ConversationsState {
  history: () => ChatHistoryState
  activeKey: () => string
  setActiveKey: (key: string) => void
  messages: () => ChatMessage[]
  setMessages: (messages: ChatMessage[]) => void
  pending: () => ChatMessage | null
  config: () => AiConfig
  setConfig: (config: AiConfig) => void
  renderThread: () => void
  applyConfigToUi: () => void
  /// Cambiar de conversación deja la sesión del agente atrás: la nueva tiene la suya.
  resetSession: () => void
}

export function buildAiChatConversations(dom: AiChatDom, state: ConversationsState) {
  let queue = Promise.resolve()

  const conversationLabel = (key: string): string => {
    if (key === GLOBAL_CHAT_CONVERSATION) return i18nT('common.generalChat')
    const context = state.history().contexts[key]
    if (context?.title) return context.title
    const project = context?.projectPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()
    return project || key
  }
  const syncAgentSelectionState = (): void => {
    const context = state.history().contexts[state.activeKey()]
    const locked = Boolean(context?.branch)
    dom.agentSelect.disabled = locked
    dom.agentSelect.title = locked ? i18nT('common.reviewAgentLocked') : ''
    dom.modeBadge.textContent = state.config().providerId === AGENT_PROVIDER_ID
      ? i18nT('common.aiModeAgent')
      : i18nT('common.aiModeChat')
    dom.reviewAgentBadge.classList.toggle('hidden', !locked)
    dom.reviewAgentBadge.textContent = locked
      ? i18nT('common.reviewAgentFixed', { agent: agentLabel(toAgentType(dom.agentSelect.value)) })
      : ''
  }
  const refreshHistorySelect = (): void => {
    dom.historySelect.replaceChildren(...Object.keys(state.history().conversations).map(key => Object.assign(document.createElement('option'), {
      value: key,
      textContent: conversationLabel(key),
    })))
    dom.historySelect.value = state.activeKey()
    dom.historyRefreshBtn.classList.toggle('hidden', !state.history().contexts[state.activeKey()]?.branch)
    dom.historyRefreshBtn.classList.remove('ai-branch-stale')
    dom.historyRefreshBtn.title = i18nT('common.updateReviewedBranch')
    syncAgentSelectionState()
  }
  const persistHistory = (): void => {
    state.history().activeConversation = state.activeKey()
    state.history().conversations[state.activeKey()] = state.messages()
      .filter(message => message !== state.pending())
      .slice(-MAX_HISTORY)
    const content = serializeChatHistory(state.history())
    queue = queue
      .then(() => invoke('chat_history_save', { content }))
      .then(() => undefined)
      .catch(() => {})
  }
  const clearConversationWorktreePath = (key: string): void => {
    const context = state.history().contexts[key]
    if (!context?.worktreePath) return
    delete context.worktreePath
    persistHistory()
  }
  const switchConversation = (key: string): void => {
    if (!key || key === state.activeKey()) return
    persistHistory()
    state.setActiveKey(key)
    state.history().activeConversation = key
    state.messages().splice(0, state.messages().length, ...(state.history().conversations[key] ?? []))
    state.history().conversations[key] ??= []
    state.resetSession()
    const context = state.history().contexts[key]
    if (context) {
      setActiveProjectPath(context.projectPath)
      state.setConfig({ ...state.config(), providerId: AGENT_PROVIDER_ID })
      dom.agentSelect.value = context.agentType
      state.applyConfigToUi()
    }
    refreshHistorySelect()
    state.renderThread()
    persistHistory()
  }

  return { conversationLabel, syncAgentSelectionState, refreshHistorySelect, persistHistory, clearConversationWorktreePath, switchConversation }
}
