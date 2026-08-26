// El estado de cada archivo según `git status --porcelain`, que es lo que
// distingue un añadido de un modificado o un renombrado. Puro: solo texto.

export function fileStateMap(raw: string): Map<string, string> {
  const states = new Map<string, string>()
  for (const line of raw.split('\n').filter(Boolean)) {
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ').at(-1) ?? path
    const state = x === '?' && y === '?' ? 'untracked'
      : x !== ' ' && y !== ' ' ? 'staged + modified'
        : x !== ' ' ? 'staged' : 'unstaged'
    states.set(path.replace(/^"|"$/g, ''), state)
  }
  return states
}
