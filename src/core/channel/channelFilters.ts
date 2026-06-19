import type { Channel } from './Channel'

export interface ChannelFilters {
  query: string
  country: string
  category: string
}

const sortedUnique = (values: string[]): string[] =>
  [...new Set(values.filter(Boolean))].sort()

export function availableCountries(channels: Channel[]): string[] {
  return sortedUnique(channels.map(c => c.country))
}

export function availableCategories(channels: Channel[]): string[] {
  return sortedUnique(channels.flatMap(c => c.categories))
}

export function applyFilters(channels: Channel[], filters: ChannelFilters): Channel[] {
  const q = filters.query.toLowerCase()

  const matches = (c: Channel): boolean => {
    const matchesQuery = !q || c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q)
    const matchesCountry = !filters.country || c.country === filters.country
    const matchesCategory = !filters.category || c.categories.includes(filters.category)
    return matchesCountry && matchesCategory && matchesQuery
  }

  return channels.filter(matches)
}
