export interface ParsedJsonValue {
  formatted: string
  kind: 'array' | 'object'
  size: number
  truncated?: boolean
}

/** Only objects and arrays get the rich viewer; ordinary SQL scalar values stay unchanged. */
export function parseStructuredJson(value: string): ParsedJsonValue | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object') return null

    const formatted = JSON.stringify(parsed, null, 2)
    const isArray = Array.isArray(parsed)
    return {
      formatted,
      kind: isArray ? 'array' : 'object',
      size: isArray ? parsed.length : Object.keys(parsed as Record<string, unknown>).length,
    }
  } catch {
    // Value starts with { or [ but couldn't be parsed. If it ends with the
    // truncation marker (…) added by the Rust backend cell clipper, treat it as
    // truncated JSON and show the badge so the user knows the cell holds JSON data.
    if (!trimmed.endsWith('…')) return null
    return {
      formatted: trimmed,
      kind: first === '[' ? 'array' : 'object',
      size: -1,
      truncated: true,
    }
  }
}
