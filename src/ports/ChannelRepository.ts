import type { Channel } from '../core/channel/Channel'

export interface ChannelRepository {
  fetchAll(): Promise<Channel[]>
}
