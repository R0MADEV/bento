import type { Channel, Stream } from '../../src/core/channel/Channel'

export function buildChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'test-channel',
    name: 'Test Channel',
    logo: '',
    country: 'US',
    categories: [],
    ...overrides,
  }
}

export function buildStream(overrides: Partial<Stream> = {}): Stream {
  return {
    channel: 'test-channel',
    url: 'https://stream.test/live.m3u8',
    ...overrides,
  }
}
