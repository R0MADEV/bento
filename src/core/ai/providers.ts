// Providers whose API keys bento stores (keychain) and injects into terminals as
// env vars. lexis reads these exact vars from process.env — bento never modifies lexis.
export interface AiProvider {
  id: string
  name: string
}

export const AI_PROVIDERS: AiProvider[] = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'groq', name: 'Groq' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Claude (Anthropic)' },
]

// lexis convention: <PROVIDER>_API_KEY (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, …).
export function providerEnvVar(id: string): string {
  return `${id.toUpperCase()}_API_KEY`
}

export function isAiProvider(id: string): boolean {
  return AI_PROVIDERS.some(p => p.id === id)
}
