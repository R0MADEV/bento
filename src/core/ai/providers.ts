// Presets for providers compatible with the OpenAI API (/chat/completions).
// They all speak the same format: only the base URL, key, and model change.

export interface AiProvider {
  id: string
  label: string
  baseUrl: string
  models: string[]
}

// The pseudo-provider that routes to local CLI agents (claude/codex/opencode)
// instead of an OpenAI-compatible HTTP endpoint.
export const AGENT_PROVIDER_ID = 'agent'

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'deepseek/deepseek-chat'],
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    models: [],
  },
  {
    id: AGENT_PROVIDER_ID,
    label: 'Agent',
    baseUrl: '',
    models: [],
  },
]

export function providerById(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find(p => p.id === id)
}
