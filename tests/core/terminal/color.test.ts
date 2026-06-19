import { describe, it, expect } from 'vitest'
import { mix, isDark } from '../../../src/core/terminal/color'

describe('mix', () => {
  it('mixes two colors at a ratio', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('ratio 0 returns the first color', () => {
    expect(mix('#112233', '#ffffff', 0)).toBe('#112233')
  })

  it('ratio 1 returns the second color', () => {
    expect(mix('#112233', '#ffffff', 1)).toBe('#ffffff')
  })
})

describe('isDark', () => {
  it('detects dark backgrounds', () => {
    expect(isDark('#1a1b26')).toBe(true)
    expect(isDark('#000000')).toBe(true)
  })

  it('detects light backgrounds', () => {
    expect(isDark('#ffffff')).toBe(false)
    expect(isDark('#f0f0f0')).toBe(false)
  })
})
