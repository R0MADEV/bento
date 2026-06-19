import { describe, it, expect } from 'vitest'
import { filterChannels } from '../../../src/core/channel/filterChannels'
import { buildChannel } from '../../helpers/channelFactory'

const channels = [
  buildChannel({ id: 'bbc-one', name: 'BBC One', country: 'GB' }),
  buildChannel({ id: 'cnn', name: 'CNN', country: 'US' }),
  buildChannel({ id: 'dazn', name: 'DAZN', country: 'ES' }),
]

describe('filterChannels', () => {
  it('returns all channels when query is empty', () => {
    expect(filterChannels(channels, '')).toHaveLength(3)
  })

  it('filters by name case-insensitive', () => {
    const result = filterChannels(channels, 'bbc')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('bbc-one')
  })

  it('filters by country', () => {
    const result = filterChannels(channels, 'US')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('cnn')
  })

  it('returns empty when no match', () => {
    expect(filterChannels(channels, 'zzznomatch')).toHaveLength(0)
  })
})
