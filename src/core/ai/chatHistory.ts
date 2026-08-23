import type { ChatMessage } from './config'

export const GLOBAL_CHAT_CONVERSATION = 'global'
const MAX_CONVERSATIONS = 50
const MAX_MESSAGES = 200
const MAX_CONTENT_CHARS = 100_000

export interface ChatHistoryState {
  version: 2
  activeConversation: string
  conversations: Record<string, ChatMessage[]>
  contexts: Record<string, ChatConversationContext>
}

export interface ChatConversationContext {
  projectPath: string
  agentType: 'claude' | 'opencode' | 'codex' | 'custom'
  title?: string
  branch?: string
  commit?: string
  worktreePath?: string
  sessionId?: string
  sessionAgent?: 'claude' | 'opencode' | 'codex' | 'custom'
  sessionCommit?: string
  evidence?: string[]
}

const validMessage = (value: unknown): value is ChatMessage => {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return ['system', 'user', 'assistant'].includes(String(message.role))
    && typeof message.content === 'string'
    && message.content.length <= MAX_CONTENT_CHARS
}

const cleanMessages = (value: unknown): ChatMessage[] =>
  Array.isArray(value) ? value.filter(validMessage).slice(-MAX_MESSAGES) : []

export function emptyChatHistory(): ChatHistoryState {
  return { version: 2, activeConversation: GLOBAL_CHAT_CONVERSATION, conversations: { [GLOBAL_CHAT_CONVERSATION]: [] }, contexts: {} }
}

export function parseChatHistory(raw: string): ChatHistoryState {
  try {
    const value = JSON.parse(raw) as unknown
    if (Array.isArray(value)) {
      return { version: 2, activeConversation: GLOBAL_CHAT_CONVERSATION, conversations: { [GLOBAL_CHAT_CONVERSATION]: cleanMessages(value) }, contexts: {} }
    }
    if (!value || typeof value !== 'object') return emptyChatHistory()
    const stored = value as Record<string, unknown>
    const source = stored.conversations
    if (stored.version !== 2 || !source || typeof source !== 'object' || Array.isArray(source)) return emptyChatHistory()
    const conversations = Object.fromEntries(
      Object.entries(source as Record<string, unknown>)
        .filter(([key]) => key.length > 0 && key.length <= 2_000)
        .slice(-MAX_CONVERSATIONS)
        .map(([key, messages]) => [key, cleanMessages(messages)]),
    )
    const active = typeof stored.activeConversation === 'string' && conversations[stored.activeConversation]
      ? stored.activeConversation
      : Object.keys(conversations)[0] ?? GLOBAL_CHAT_CONVERSATION
    if (!conversations[active]) conversations[active] = []
    const contextSource = stored.contexts && typeof stored.contexts === 'object' && !Array.isArray(stored.contexts)
      ? stored.contexts as Record<string, unknown>
      : {}
    const contexts = Object.fromEntries(Object.entries(contextSource).filter((entry): entry is [string, ChatConversationContext] => {
      const [key, context] = entry
      if (!conversations[key] || !context || typeof context !== 'object') return false
      const value = context as Record<string, unknown>
      return typeof value.projectPath === 'string' && value.projectPath.length <= 2_000
        && ['claude', 'opencode', 'codex', 'custom'].includes(String(value.agentType))
        && (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 500))
        && (value.branch === undefined || (typeof value.branch === 'string' && value.branch.length <= 2_000))
        && (value.commit === undefined || (typeof value.commit === 'string' && /^[0-9a-f]{40,64}$/i.test(value.commit)))
        && (value.worktreePath === undefined || (typeof value.worktreePath === 'string' && value.worktreePath.length <= 2_000))
        && (value.sessionId === undefined || (typeof value.sessionId === 'string' && /^[A-Za-z0-9._:-]{1,500}$/.test(value.sessionId)))
        && (value.sessionAgent === undefined || ['claude', 'opencode', 'codex', 'custom'].includes(String(value.sessionAgent)))
        && (value.sessionCommit === undefined || (typeof value.sessionCommit === 'string' && /^[0-9a-f]{40,64}$/i.test(value.sessionCommit)))
        && (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.length <= 100 && value.evidence.every(item => typeof item === 'string' && item.length <= 1_000)))
    }))
    return { version: 2, activeConversation: active, conversations, contexts }
  } catch {
    return emptyChatHistory()
  }
}

export function serializeChatHistory(state: ChatHistoryState): string {
  return JSON.stringify(state)
}

// A review conversation only sends a recent window to the agent, but the first
// assistant message (the review report) carries context that must survive the
// whole conversation — so it stays pinned at the front once history grows past it.
export function pinnedFollowUpHistory(full: ChatMessage[], hasBranch: boolean): ChatMessage[] {
  if (!hasBranch || full.length <= 20) return full
  const report = full.find(m => m.role === 'assistant')
  const recent = full.slice(-19)
  return report && !recent.includes(report) ? [report, ...recent] : full.slice(-20)
}

export function techReviewConversationKey(projectPath: string, branch: string): string {
  const normalizedPath = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return `tech-review:${normalizedPath}:${branch.trim() || 'branch'}`
}

// localStorage key for the last saved review document of a branch, so a crash or
// reload never loses the findings.
export function techReviewCheckpointKey(projectPath: string, branch: string): string {
  return `${techReviewConversationKey(projectPath, branch)}:checkpoint`
}
