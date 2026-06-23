const MAX = 40

// The tab title for a note: its first non-empty line, trimmed and truncated.
export function noteTitle(content: string): string {
  const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (!firstLine) return 'Nota'
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine
}
