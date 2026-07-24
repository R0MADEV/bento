
// Parseo del streaming SSE de la API tipo OpenAI (/chat/completions con stream:true).
// El cuerpo llega como texto en trozos arbitrarios; estas funciones puras permiten
// acumular, trocear en líneas completas y extraer el delta de cada una.

// Divide el buffer acumulado en líneas completas y devuelve el resto sin terminar
// (la última línea sin '\n' todavía puede estar a medias en el siguiente chunk).
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

// True si la línea es el centinela de fin de stream.
export function isDoneLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return false
  return trimmed.slice(5).trim() === '[DONE]'
}

// Extrae el texto incremental de una línea `data: {...}`. Devuelve null si la línea
// no aporta contenido (comentarios, blancos, [DONE], chunk de rol, o JSON inválido).
export function deltaFromLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null
  try {
    const json = JSON.parse(payload)
    return json?.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}
