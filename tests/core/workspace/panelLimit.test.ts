import { describe, it, expect } from 'vitest'
import { canAddPanel } from '../../../src/core/workspace/panelLimit'

describe('canAddPanel', () => {
  it('non-singleton types can always be added', () => {
    expect(canAddPanel({ singleton: false, unlocked: false, alreadyExists: true })).toBe(true)
  })

  it('singleton: allowed when none exists yet', () => {
    expect(canAddPanel({ singleton: true, unlocked: false, alreadyExists: false })).toBe(true)
  })

  it('singleton: blocked when one already exists', () => {
    expect(canAddPanel({ singleton: true, unlocked: false, alreadyExists: true })).toBe(false)
  })

  it('singleton: unlocked allows multiples', () => {
    expect(canAddPanel({ singleton: true, unlocked: true, alreadyExists: true })).toBe(true)
  })
})
