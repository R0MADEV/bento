import { describe, it, expect } from 'vitest'
import { countryOptions, categoryOptions } from '../../../src/core/channel/filterOptions'
import { buildChannel } from '../../helpers/channelFactory'
import type { Country, Category } from '../../../src/core/channel/Channel'

const channels = [
  buildChannel({ country: 'US', categories: ['news'] }),
  buildChannel({ country: 'GB', categories: ['sports'] }),
]
const countries: Country[] = [
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'ES', name: 'Spain', flag: '🇪🇸' },
]
const categories: Category[] = [
  { id: 'news', name: 'News' },
  { id: 'sports', name: 'Sports' },
  { id: 'kids', name: 'Kids' },
]

describe('countryOptions', () => {
  it('returns only countries present in channels, with flag and name, sorted', () => {
    expect(countryOptions(channels, countries)).toEqual([
      { value: 'GB', label: '🇬🇧 United Kingdom' },
      { value: 'US', label: '🇺🇸 United States' },
    ])
  })
})

describe('categoryOptions', () => {
  it('returns only categories present in channels, by name, sorted', () => {
    expect(categoryOptions(channels, categories)).toEqual([
      { value: 'news', label: 'News' },
      { value: 'sports', label: 'Sports' },
    ])
  })
})
