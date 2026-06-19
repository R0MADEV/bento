import { describe, it, expect } from 'vitest'
import { nextTheme } from '../../../src/core/terminal/nextTheme'

describe('nextTheme', () => {
  it('cycles to the next theme', () => {
    expect(nextTheme('dark', ['dark', 'light'])).toBe('light')
  })

  it('wraps around to the first', () => {
    expect(nextTheme('light', ['dark', 'light'])).toBe('dark')
  })

  it('returns the first theme for an unknown current', () => {
    expect(nextTheme('nope', ['dark', 'light'])).toBe('dark')
  })
})
