import { describe, it, expect } from 'vitest'
import { filterCommands, type Command } from '../../src/core/command/command'

const cmds: Command[] = [
  { id: 'new-session', label: 'Nueva sesión', run: () => {} },
  { id: 'theme-dark', label: 'Tema: Tokyo Night', keywords: ['theme', 'oscuro'], run: () => {} },
  { id: 'new-terminal', label: 'Nueva terminal', run: () => {} },
]

describe('filterCommands', () => {
  it('returns all for an empty query', () => {
    expect(filterCommands(cmds, '')).toHaveLength(3)
  })

  it('matches the label case-insensitively', () => {
    expect(filterCommands(cmds, 'TERMINAL').map(c => c.id)).toEqual(['new-terminal'])
  })

  it('matches keywords', () => {
    expect(filterCommands(cmds, 'oscuro').map(c => c.id)).toEqual(['theme-dark'])
  })

  it('returns empty when nothing matches', () => {
    expect(filterCommands(cmds, 'zzz')).toEqual([])
  })
})
