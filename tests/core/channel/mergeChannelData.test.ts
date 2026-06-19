import { describe, it, expect } from 'vitest'
import { mergeChannelData } from '../../../src/core/channel/mergeChannelData'
import { buildChannel } from '../../helpers/channelFactory'
import type { ChannelData } from '../../../src/core/channel/Channel'

const a: ChannelData = {
  channels: [buildChannel({ id: '1', categories: ['Deportes'] })],
  countries: [{ code: 'ES', name: 'Spain', flag: '🇪🇸' }],
  categories: [],
}
const b: ChannelData = {
  channels: [buildChannel({ id: '2', categories: ['Noticias'] })],
  countries: [{ code: 'ES', name: 'Spain', flag: '🇪🇸' }, { code: 'US', name: 'USA', flag: '🇺🇸' }],
  categories: [],
}

describe('mergeChannelData', () => {
  it('concatenates channels from all sources', () => {
    expect(mergeChannelData([a, b]).channels.map(c => c.id)).toEqual(['1', '2'])
  })

  it('dedupes countries by code', () => {
    expect(mergeChannelData([a, b]).countries.map(c => c.code)).toEqual(['ES', 'US'])
  })

  it('builds categories from the union of channel categories, sorted', () => {
    expect(mergeChannelData([a, b]).categories).toEqual([
      { id: 'Deportes', name: 'Deportes' },
      { id: 'Noticias', name: 'Noticias' },
    ])
  })
})
