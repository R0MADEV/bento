// Returns the next theme in the cycle (wraps back to the first at the end).
export function nextTheme(current: string, names: string[]): string {
  const index = names.indexOf(current)
  return names[(index + 1) % names.length] ?? names[0]
}
