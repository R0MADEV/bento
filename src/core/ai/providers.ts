// Presets de proveedores compatibles con la API de OpenAI (/chat/completions).
// Todos hablan el mismo formato: solo cambia base URL, key y modelo.

export interface AiProvider {
  id: string
  label: string
  baseUrl: string
  models: string[]
}

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
]

export function providerById(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find(p => p.id === id)
}
