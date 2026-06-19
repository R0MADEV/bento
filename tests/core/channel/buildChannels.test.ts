import { describe, it, expect } from 'vitest'
import { buildChannels } from '../../../src/core/channel/buildChannels'
import type { RawChannel, Stream, Logo } from '../../../src/core/channel/Channel'

const channels: RawChannel[] = [
  { id: 'bbc-one', name: 'BBC One', country: 'GB', categories: ['news'] },
]
const logos: Logo[] = [{ channel: 'bbc-one', url: 'https://logo/bbc.png' }]

describe('buildChannels', () => {
  it('creates one item per stream that has a url', () => {
    const streams: Stream[] = [
      { channel: 'bbc-one', title: 'BBC One HD', url: 'https://s1.m3u8' },
      { channel: null, title: 'Pirate TV', url: 'https://s2.m3u8' },
    ]
    expect(buildChannels(streams, channels, logos)).toHaveLength(2)
  })

  it('uses the stream title as name', () => {
    const streams: Stream[] = [{ channel: 'bbc-one', title: 'BBC One HD', url: 'https://s1.m3u8' }]
    expect(buildChannels(streams, channels, logos)[0].name).toBe('BBC One HD')
  })

  it('falls back to channel name when title is null', () => {
    const streams: Stream[] = [{ channel: 'bbc-one', title: null, url: 'https://s1.m3u8' }]
    expect(buildChannels(streams, channels, logos)[0].name).toBe('BBC One')
  })

  it('attaches logo, country and categories from the linked channel', () => {
    const streams: Stream[] = [{ channel: 'bbc-one', title: 'BBC', url: 'https://s1.m3u8' }]
    const item = buildChannels(streams, channels, logos)[0]
    expect(item.logo).toBe('https://logo/bbc.png')
    expect(item.country).toBe('GB')
    expect(item.categories).toEqual(['Noticias'])
  })

  it('leaves logo/country empty for unlinked streams', () => {
    const streams: Stream[] = [{ channel: null, title: 'Pirate TV', url: 'https://s2.m3u8' }]
    const item = buildChannels(streams, channels, logos)[0]
    expect(item.logo).toBe('')
    expect(item.country).toBe('')
    expect(item.streamUrl).toBe('https://s2.m3u8')
  })
})
