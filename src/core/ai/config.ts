// Configuración NO secreta del chat de IA (proveedor, endpoint, modelo) en
// localStorage. Las API keys NO se guardan aquí: van al Vault cifrado
// (ver src/ui/aiKeys.ts).

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

// Config NO secreta (localStorage). Las API keys van al Vault cifrado,
// nunca aquí — ver src/ui/aiKeys.ts.
export interface AiConfig {
  providerId: string
  baseUrl: string
  model: string
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  providerId: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
}

const KEY = 'bento.ai.config'

// Mezcla lo guardado sobre los defaults: tolera JSON inválido y claves ausentes.
export function parseConfig(raw: string | null): AiConfig {
  if (!raw) return { ...DEFAULT_AI_CONFIG }
  try {
    const obj = JSON.parse(raw) as Partial<AiConfig>
    return {
      providerId: obj.providerId ?? DEFAULT_AI_CONFIG.providerId,
      baseUrl: obj.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl,
      model: obj.model ?? DEFAULT_AI_CONFIG.model,
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

// Cuerpo de la petición a /chat/completions con streaming.
export function buildChatBody(messages: ChatMessage[], model: string): {
  model: string
  messages: ChatMessage[]
  stream: true
} {
  return { model, messages, stream: true }
}
