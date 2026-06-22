import { describe, it, expect } from 'vitest'
import { parseBarPosition } from '../../src/ui/sessionBarPreference'

describe('parseBarPosition', () => {
  it('keeps a valid position', () => {
    expect(parseBarPosition('left')).toBe('left')
    expect(parseBarPosition('bottom')).toBe('bottom')
  })

  it('falls back to top for null or unknown values', () => {
    expect(parseBarPosition(null)).toBe('top')
    expect(parseBarPosition('diagonal')).toBe('top')
  })
})
