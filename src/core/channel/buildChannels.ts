import type { Channel, RawChannel, Stream, Logo } from './Channel'
import { translateCategory } from './translate'

// Builds the playable list from the streams (they always have a url),
// enriching it with channel data (country, categories) and its logo.
// Categories are translated to Spanish so they can be merged with other sources.
export function buildChannels(streams: Stream[], channels: RawChannel[], logos: Logo[]): Channel[] {
  const channelById = new Map(channels.map(c => [c.id, c]))
  const logoByChannel = new Map(
    logos.filter(l => l.channel).map(l => [l.channel as string, l.url])
  )

  return streams
    .filter(s => s.url)
    .map(s => {
      const channel = s.channel ? channelById.get(s.channel) : undefined
      return {
        id: s.url,
        name: s.title ?? channel?.name ?? s.channel ?? 'Sin nombre',
        logo: s.channel ? (logoByChannel.get(s.channel) ?? '') : '',
        country: channel?.country ?? '',
        categories: (channel?.categories ?? []).map(translateCategory),
        streamUrl: s.url,
      }
    })
}
