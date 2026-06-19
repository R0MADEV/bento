import type { Channel, Stream } from './Channel'

export function mergeStreams(channels: Channel[], streams: Stream[]): Channel[] {
  const streamByChannel = new Map(streams.map(s => [s.channel, s.url]))
  return channels.map(ch => ({ ...ch, streamUrl: streamByChannel.get(ch.id) }))
}
