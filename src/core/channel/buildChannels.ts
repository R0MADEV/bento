import type { Channel, RawChannel, Stream, Logo } from './Channel'

// Construye la lista reproducible a partir de los streams (siempre tienen url),
// enriqueciendo con datos del canal (país, categorías) y su logo.
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
        categories: channel?.categories ?? [],
        streamUrl: s.url,
      }
    })
}
