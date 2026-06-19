import { describe, it, expect } from 'vitest'
import { lowestAvailableNumber } from '../../../src/core/terminal/lowestAvailableNumber'

describe('lowestAvailableNumber', () => {
  it('returns 1 when nothing is used', () => {
    expect(lowestAvailableNumber([])).toBe(1)
  })

  it('returns the gap when a middle number is free', () => {
    expect(lowestAvailableNumber([1, 3])).toBe(2)
  })

  it('returns next number when all are contiguous', () => {
    expect(lowestAvailableNumber([1, 2, 3])).toBe(4)
  })

  it('reuses the lowest freed number', () => {
    expect(lowestAvailableNumber([1, 3, 4])).toBe(2)
  })

  it('ignores order and duplicates', () => {
    expect(lowestAvailableNumber([3, 1, 1])).toBe(2)
  })
})
