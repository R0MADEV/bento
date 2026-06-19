import type { Channel, Country, Category } from './Channel'
import { availableCountries, availableCategories } from './channelFilters'

export interface FilterOption {
  value: string
  label: string
}

export function countryOptions(channels: Channel[], countries: Country[]): FilterOption[] {
  const present = new Set(availableCountries(channels))
  return countries
    .filter(c => present.has(c.code))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({ value: c.code, label: `${c.flag} ${c.name}` }))
}

export function categoryOptions(channels: Channel[], categories: Category[]): FilterOption[] {
  const present = new Set(availableCategories(channels))
  return categories
    .filter(c => present.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => ({ value: c.id, label: c.name }))
}
