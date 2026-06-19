import type { ChannelData, Country, Category } from './Channel'

// Combina varias fuentes de canales en un único ChannelData.
export function mergeChannelData(sources: ChannelData[]): ChannelData {
  const channels = sources.flatMap(s => s.channels)

  const countryByCode = new Map<string, Country>()
  sources.flatMap(s => s.countries).forEach(c => {
    if (!countryByCode.has(c.code)) countryByCode.set(c.code, c)
  })

  const categoryIds = new Set(channels.flatMap(c => c.categories))
  const categories: Category[] = [...categoryIds].sort().map(id => ({ id, name: id }))

  return { channels, countries: [...countryByCode.values()], categories }
}
