import { describe, it, expect } from 'vitest'
import { publishedPort } from '../../../src/core/db/hostPort'

describe('publishedPort', () => {
  it('finds the host port mapped to the internal port', () => {
    expect(publishedPort('0.0.0.0:3307->3306/tcp', 3306)).toBe(3307)
  })

  it('handles the IPv6 duplicate and multiple mappings', () => {
    expect(publishedPort('0.0.0.0:3307->3306/tcp, :::3307->3306/tcp', 3306)).toBe(3307)
  })

  it('returns null when the internal port is not published', () => {
    expect(publishedPort('3306/tcp', 3306)).toBeNull()
    expect(publishedPort('', 3306)).toBeNull()
  })

  it('does not confuse a host port that matches the internal number', () => {
    // host 5432 -> internal 3306 must not be read as the 3306 mapping
    expect(publishedPort('0.0.0.0:5432->3306/tcp', 3306)).toBe(5432)
  })
})
