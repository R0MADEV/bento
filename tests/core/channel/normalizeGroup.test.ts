import { describe, it, expect } from 'vitest'
import { normalizeGroup } from '../../../src/core/channel/normalizeGroup'

describe('normalizeGroup', () => {
  it('maps Spanish regions to Autonómicas + country ES', () => {
    expect(normalizeGroup('Andalucía')).toEqual({ category: 'Autonómicas', country: 'ES' })
    expect(normalizeGroup('País Vasco')).toEqual({ category: 'Autonómicas', country: 'ES' })
  })

  it('maps international groups to Internacional with no country', () => {
    expect(normalizeGroup('Int. Europa')).toEqual({ category: 'Internacional', country: '' })
    expect(normalizeGroup('Int. América')).toEqual({ category: 'Internacional', country: '' })
  })

  it('maps content groups to a clean Spanish type, country ES', () => {
    expect(normalizeGroup('Deportivos')).toEqual({ category: 'Deportes', country: 'ES' })
    expect(normalizeGroup('Musicales')).toEqual({ category: 'Música', country: 'ES' })
    expect(normalizeGroup('Infantiles')).toEqual({ category: 'Infantil', country: 'ES' })
  })

  it('keeps unknown groups as-is with country ES', () => {
    expect(normalizeGroup('Generalistas')).toEqual({ category: 'Generalistas', country: 'ES' })
  })
})
