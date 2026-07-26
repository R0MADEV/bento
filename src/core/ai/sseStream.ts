
// Parsing of the SSE stream from the OpenAI-style API (/chat/completions with stream:true).
// The body arrives as text in arbitrary chunks; these pure functions let you
// accumulate it, break it into complete lines, and extract the delta from each one.

// Splits the accumulated buffer into complete lines and returns the unfinished remainder
// (the last line without a '\n' may still be partial and continue in the next chunk).
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

// True if the line is the end-of-stream sentinel.
export function isDoneLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return false
  return trimmed.slice(5).trim() === '[DONE]'
}

// Extracts the incremental text from a `data: {...}` line. Returns null if the line
// carries no content (comments, blanks, [DONE], role chunk, or invalid JSON).
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
