import type { Channel } from './Channel'
import { normalizeGroup } from './normalizeGroup'

const attr = (line: string, name: string): string =>
  new RegExp(`${name}="([^"]*)"`).exec(line)?.[1] ?? ''

// Parsea una playlist M3U (#EXTINF + url) a la lista de canales de Bento.
export function parseM3U(text: string): Channel[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const channels: Channel[] = []
  let pending: { name: string; logo: string; group: string } | null = null

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      pending = {
        name: line.slice(line.lastIndexOf(',') + 1).trim(),
        logo: attr(line, 'tvg-logo'),
        group: attr(line, 'group-title'),
      }
      continue
    }
    if (line.startsWith('#')) continue
    if (!pending) continue

    const { category, country } = normalizeGroup(pending.group)
    channels.push({
      id: line,
      name: pending.name || line,
      logo: pending.logo,
      country,
      categories: category ? [category] : [],
      streamUrl: line,
    })
    pending = null
  }

  return channels
}
