// Puente ligero para enviar contexto al chat de IA desde cualquier panel, sin
// acoplarse al widget entero: solo despacha un evento que el chat escucha.

export const AI_ASK_EVENT = 'bento:ai-ask'

export interface AiAskDetail {
  text: string
  autoSend?: boolean
}

// Abre el chat con el texto precargaqudo; autoSend=true lo envía directamente.
export function askAi(text: string, autoSend = false): void {
  window.dispatchEvent(new CustomEvent<AiAskDetail>(AI_ASK_EVENT, { detail: { text, autoSend } }))
}
