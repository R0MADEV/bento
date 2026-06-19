import { describe, it, expect } from 'vitest'
import { deriveAppVars } from '../../../src/core/terminal/appVars'
import { getTheme } from '../../../src/core/terminal/themes'

describe('deriveAppVars', () => {
  it('exposes the core surfaces from the theme', () => {
    const vars = deriveAppVars(getTheme('dark'))
    expect(vars['--bg']).toBe('#1a1b26')
    expect(vars['--fg']).toBe('#c0caf5')
    expect(vars['--accent']).toBe('#7aa2f7')
  })

  it('derives a surface lighter than bg for dark themes', () => {
    const vars = deriveAppVars(getTheme('dark'))
    expect(vars['--surface']).not.toBe(vars['--bg'])
  })

  it('provides all expected variables', () => {
    const vars = deriveAppVars(getTheme('dracula'))
    for (const key of ['--bg', '--surface', '--surface-2', '--border', '--fg', '--fg-dim', '--accent', '--accent-fg', '--selection']) {
      expect(vars[key]).toBeDefined()
    }
  })
})
