import type { ChannelRepository } from '../ports/ChannelRepository'
import type { Channel, Stream } from '../core/channel/Channel'
import { mergeStreams } from '../core/channel/mergeStreams'

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json'
const STREAMS_URL = 'https://iptv-org.github.io/api/streams.json'

export class IptvOrgChannelRepository implements ChannelRepository {
  async fetchAll(): Promise<Channel[]> {
    const [channelsRes, streamsRes] = await Promise.all([
      fetch(CHANNELS_URL),
      fetch(STREAMS_URL),
    ])
    const channels: Channel[] = await channelsRes.json()
    const streams: Stream[] = await streamsRes.json()
    return mergeStreams(channels, streams)
  }
}
