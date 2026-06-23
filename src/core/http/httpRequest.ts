// Headers typed as "Key: Value" lines → ordered pairs (split on the first colon).
export function parseHeaders(text: string): [string, string][] {
  return text
    .split('\n')
    .map(line => {
      const i = line.indexOf(':')
      if (i === -1) return null
      const key = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim()
      return key ? ([key, value] as [string, string]) : null
    })
    .filter((p): p is [string, string] => p !== null)
}

// Pretty-print a response body when it is JSON; otherwise return it unchanged.
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

// Unfilled {param} placeholders in a URL (reqwest can't build a URL with braces).
export function urlParams(url: string): string[] {
  return [...url.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
}

// Append a "Key: Value" header line, skipping it if the key already exists.
export function addHeaderLine(text: string, line: string): string {
  const key = line.slice(0, line.indexOf(':')).trim().toLowerCase()
  const exists = parseHeaders(text).some(([k]) => k.toLowerCase() === key)
  if (exists) return text
  const trimmed = text.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n${line}` : line
}
