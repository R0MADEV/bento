import { describe, it, expect } from 'vitest'
import { parseM3U } from '../../../src/core/channel/parseM3U'

const sample = `#EXTM3U
#EXTINF:-1 tvg-id="La1.TV" tvg-logo="https://logo/la1.jpg" group-title="Generalistas" tvg-name="La 1",La 1
https://stream/la1.m3u8
#EXTINF:-1 tvg-logo="https://logo/tdp.jpg" group-title="Deportivos",Teledeporte
https://stream/tdp.m3u8`

describe('parseM3U', () => {
  it('parses each channel with name, logo, normalized category and stream url', () => {
    const channels = parseM3U(sample)
    expect(channels).toHaveLength(2)
    expect(channels[0]).toMatchObject({
      name: 'La 1',
      logo: 'https://logo/la1.jpg',
      categories: ['Generalistas'],
      streamUrl: 'https://stream/la1.m3u8',
    })
  })

  it('normalizes the group-title into a clean category', () => {
    expect(parseM3U(sample)[1].categories).toEqual(['Deportes'])
  })

  it('uses the stream url as id', () => {
    expect(parseM3U(sample)[1].id).toBe('https://stream/tdp.m3u8')
  })

  it('sets country ES for Spanish channels', () => {
    expect(parseM3U(sample)[0].country).toBe('ES')
  })

  it('ignores comments and blank lines, returns empty for no channels', () => {
    expect(parseM3U('#EXTM3U\n\n')).toEqual([])
  })
})
