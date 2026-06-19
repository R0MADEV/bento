import type { ChannelData } from '../core/channel/Channel'

export interface ChannelRepository {
  fetchAll(): Promise<ChannelData>
}
