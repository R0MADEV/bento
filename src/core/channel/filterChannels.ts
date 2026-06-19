import type { Channel } from './Channel'

export function filterChannels(channels: Channel[], query: string): Channel[] {
  if (!query) return channels
  const q = query.toLowerCase()
  const matchesQuery = (ch: Channel) =>
    ch.name.toLowerCase().includes(q) || ch.country.toLowerCase().includes(q)
  return channels.filter(matchesQuery)
}
