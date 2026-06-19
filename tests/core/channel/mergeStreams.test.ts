import { describe, it, expect } from 'vitest'
import { mergeStreams } from '../../../src/core/channel/mergeStreams'
import { buildChannel, buildStream } from '../../helpers/channelFactory'

const channels = [
  buildChannel({ id: 'bbc-one', name: 'BBC One' }),
  buildChannel({ id: 'dazn', name: 'DAZN' }),
]

const streams = [
  buildStream({ channel: 'bbc-one', url: 'https://stream1.m3u8' }),
]

describe('mergeStreams', () => {
  it('attaches stream url to matching channel', () => {
    const result = mergeStreams(channels, streams)
    const bbc = result.find(c => c.id === 'bbc-one')
    expect(bbc?.streamUrl).toBe('https://stream1.m3u8')
  })

  it('leaves streamUrl undefined when no stream exists', () => {
    const result = mergeStreams(channels, streams)
    const dazn = result.find(c => c.id === 'dazn')
    expect(dazn?.streamUrl).toBeUndefined()
  })
})
