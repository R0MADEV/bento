import { describe, it, expect } from 'vitest'
import { exposedPorts } from '../../../src/core/db/exposedPorts'

describe('exposedPorts', () => {
  it('reads the container-side port whether published or just exposed', () => {
    expect(exposedPorts('3306/tcp')).toEqual([3306])
    expect(exposedPorts('0.0.0.0:3307->3306/tcp')).toEqual([3306])
  })

  it('dedupes the IPv4/IPv6 duplicate', () => {
    expect(exposedPorts('0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp')).toEqual([3000])
  })

  it('returns every distinct exposed port', () => {
    expect(exposedPorts('80/tcp, 443/tcp')).toEqual([80, 443])
  })

  it('returns empty when nothing is exposed', () => {
    expect(exposedPorts('')).toEqual([])
  })
})
