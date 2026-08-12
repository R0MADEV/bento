// Non-secret AI chat configuration (provider, endpoint, model) in
// localStorage. API keys are NOT stored here: they go to the encrypted Vault
// (see src/ui/aiKeys.ts).

export type AgentType = 'claude' | 'opencode' | 'codex' | 'custom'

const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  custom: 'Agent',
}

export function agentLabel(agent: AgentType): string {
  return AGENT_LABELS[agent]
}

// Normalizes an untrusted string (a <select> value, persisted config) into a
// known AgentType, defaulting to claude for anything unexpected.
export function toAgentType(value: string): AgentType {
  return value in AGENT_LABELS ? value as AgentType : 'claude'
}

export interface AgentConfig {
  type: AgentType
  executable?: string
  args?: string[]
}

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

// Non-secret config (localStorage). API keys go to the encrypted Vault,
// never here — see src/ui/aiKeys.ts.
export interface AiConfig {
  providerId: string
  baseUrl: string
  model: string
  systemPrompt: string
  agentExecutable?: string
  agentArgs?: string
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  providerId: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  systemPrompt: '',
}

const KEY = 'bento.ai.config'

// Merges the stored values over the defaults: tolerates invalid JSON and missing keys.
export function parseConfig(raw: string | null): AiConfig {
  if (!raw) return { ...DEFAULT_AI_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<AiConfig>
    return {
      providerId: obj.providerId ?? DEFAULT_AI_CONFIG.providerId,
      baseUrl: obj.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl,
      model: obj.model ?? DEFAULT_AI_CONFIG.model,
      systemPrompt: obj.systemPrompt ?? DEFAULT_AI_CONFIG.systemPrompt,
      agentExecutable: obj.agentExecutable,
      agentArgs: obj.agentArgs,
    }
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export function loadConfig(): AiConfig {
  return parseConfig(localStorage.getItem(KEY))
}

export function saveConfig(cfg: AiConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg))
}

// Request body for /chat/completions with streaming.
export function buildChatBody(messages: ChatMessage[], model: string): {
  model: string
  messages: ChatMessage[]
  stream: true
} {
  return { model, messages, stream: true }
}
