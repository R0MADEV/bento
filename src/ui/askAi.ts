// Lightweight bridge to send context to the AI chat from any panel, without
// coupling to the whole widget: it just dispatches an event the chat listens for.

export const AI_ASK_EVENT = 'bento:ai-ask'

// Runs a query the AI has written and returns the element to display
// (table or text). Provided by the panel that opens the chat (e.g. the DB one), bound
// to its active connection. This way the chat can execute without knowing the DB.
export type AiQueryRunner = (query: string) => Promise<HTMLElement>

// Tool (function-calling) the AI can invoke: e.g. the DB panel
// offers get_columns so the AI can query real columns on demand.
export interface AiTool {
  name: string
  // OpenAI tool spec: { type: 'function', function: { name, description, parameters } }
  schema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string>
}

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
}

// Opens the chat with the text preloaded; autoSend=true sends it directly.
// runner (optional) enables "Run" on code blocks; tools (optional)
// enables function-calling (the AI requests schema data on demand).
// inject (optional) prepends a synthetic assistant message to the thread.
// projectPath + agentType switch the chat to agent mode for immediate follow-ups.
export function askAi(text: string, autoSend = false, runner?: AiQueryRunner, tools?: AiTool[], inject?: { role: 'assistant'; content: string }, projectPath?: string, agentType?: string, conversationKey?: string, conversationTitle?: string, conversationBranch?: string, conversationCommit?: string): void {
  window.dispatchEvent(new CustomEvent<AiAskDetail>(AI_ASK_EVENT, { detail: { text, autoSend, runner, tools, inject, projectPath, agentType, conversationKey, conversationTitle, conversationBranch, conversationCommit } }))
}
