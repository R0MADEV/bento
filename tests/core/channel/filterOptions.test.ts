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
  it('returns only present countries with flag and Spanish name, sorted', () => {
    expect(countryOptions(channels, countries)).toEqual([
      { value: 'US', label: '🇺🇸 Estados Unidos' },
      { value: 'GB', label: '🇬🇧 Reino Unido' },
    ])
  })
})

describe('categoryOptions', () => {
  it('returns only present categories with Spanish name, sorted', () => {
    expect(categoryOptions(channels, categories)).toEqual([
      { value: 'sports', label: 'Deportes' },
      { value: 'news', label: 'Noticias' },
    ])
  })
})
