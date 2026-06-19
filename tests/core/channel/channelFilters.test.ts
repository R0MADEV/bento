import { describe, it, expect } from 'vitest'
import { availableCountries, availableCategories, applyFilters } from '../../../src/core/channel/channelFilters'
import { buildChannel } from '../../helpers/channelFactory'

const channels = [
  buildChannel({ id: '1', name: 'BBC', country: 'GB', categories: ['news'] }),
  buildChannel({ id: '2', name: 'CNN', country: 'US', categories: ['news'] }),
  buildChannel({ id: '3', name: 'ESPN', country: 'US', categories: ['sports'] }),
  buildChannel({ id: '4', name: 'Pirate', country: '', categories: [] }),
]

describe('availableCountries', () => {
  it('returns sorted unique non-empty countries', () => {
    expect(availableCountries(channels)).toEqual(['GB', 'US'])
  })
})

describe('availableCategories', () => {
  it('returns sorted unique categories', () => {
    expect(availableCategories(channels)).toEqual(['news', 'sports'])
  })
})

describe('applyFilters', () => {
  it('returns all with empty filters', () => {
    expect(applyFilters(channels, { query: '', country: '', category: '' })).toHaveLength(4)
  })

  it('filters by country', () => {
    const r = applyFilters(channels, { query: '', country: 'US', category: '' })
    expect(r.map(c => c.id)).toEqual(['2', '3'])
  })

  it('filters by category', () => {
    const r = applyFilters(channels, { query: '', country: '', category: 'news' })
    expect(r.map(c => c.id)).toEqual(['1', '2'])
  })

  it('combines query, country and category', () => {
    const r = applyFilters(channels, { query: 'cnn', country: 'US', category: 'news' })
    expect(r.map(c => c.id)).toEqual(['2'])
  })
})
