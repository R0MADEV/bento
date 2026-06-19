import { describe, it, expect } from 'vitest'
import { getTheme, themeNames, DEFAULT_THEME } from '../../../src/core/terminal/themes'

describe('terminal themes', () => {
  it('exposes at least dark and light themes', () => {
    expect(themeNames).toContain('dark')
    expect(themeNames).toContain('light')
  })

  it('returns a theme object with background and foreground', () => {
    const theme = getTheme('dark')
    expect(theme.background).toBeDefined()
    expect(theme.foreground).toBeDefined()
  })

  it('returns the default theme for an unknown name', () => {
    expect(getTheme('nonexistent')).toEqual(getTheme(DEFAULT_THEME))
  })

  it('light theme has a light background', () => {
    const light = getTheme('light')
    expect(light.background?.toLowerCase()).not.toBe('#000000')
  })
})
