export interface Command {
  id: string
  label: string
  hint?: string
  keywords?: string[]
  run: () => void
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands

  const matches = (c: Command): boolean => {
    const haystack = [c.label, ...(c.keywords ?? [])].join(' ').toLowerCase()
    return haystack.includes(q)
  }
  return commands.filter(matches)
}
