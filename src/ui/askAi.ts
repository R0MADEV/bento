// Lightweight bridge to send context to the AI chat from any panel, without
// coupling to the whole widget: it just dispatches an event the chat listens for.

export const AI_ASK_EVENT = 'bento:ai-ask'

// Runs a query the AI has written and returns the element to display
// (table or text). Provided by the panel that opens the chat (e.g. the DB one), bound
// to its active connection. This way the chat can execute without knowing the DB.
import type { AiTool } from '../core/ai/tools'

export type AiQueryRunner = (query: string) => Promise<HTMLElement>

export type { AiTool } from '../core/ai/tools'

export interface AiAskDetail {
  text: string
  autoSend?: boolean
  runner?: AiQueryRunner
  tools?: AiTool[]
  inject?: { role: 'assistant'; content: string }
  projectPath?: string
  agentType?: string
  conversationKey?: string
  conversationTitle?: string
  conversationBranch?: string
  conversationCommit?: string
  conversationSessionId?: string
  conversationSessionAgent?: string
  conversationEvidence?: string[]
}

// Opens the chat with the text preloaded; autoSend=true sends it directly.
// runner (optional) enables "Run" on code blocks; tools (optional)
// enables function-calling (the AI requests schema data on demand).
// inject (optional) prepends a synthetic assistant message to the thread.
// projectPath + agentType switch the chat to agent mode for immediate follow-ups.
export function askAi(text: string, autoSend = false, runner?: AiQueryRunner, tools?: AiTool[], inject?: { role: 'assistant'; content: string }, projectPath?: string, agentType?: string, conversationKey?: string, conversationTitle?: string, conversationBranch?: string, conversationCommit?: string, conversationSessionId?: string, conversationSessionAgent?: string, conversationEvidence?: string[]): void {
  window.dispatchEvent(new CustomEvent<AiAskDetail>(AI_ASK_EVENT, { detail: { text, autoSend, runner, tools, inject, projectPath, agentType, conversationKey, conversationTitle, conversationBranch, conversationCommit, conversationSessionId, conversationSessionAgent, conversationEvidence } }))
}
