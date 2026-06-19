const SPECIAL: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  Delete: '\x1b[3~',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
}

export function keyToSequence(e: KeyboardEvent): string | null {
  if (SPECIAL[e.key]) return SPECIAL[e.key]

  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toLowerCase().charCodeAt(0) - 96
    const isControlCode = code > 0 && code < 32
    if (isControlCode) return String.fromCharCode(code)
  }

  const isPrintable = !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1
  if (isPrintable) return e.key

  return null
}
