import { describe, it, expect } from 'vitest'
import { normalizeUrl } from '../../../src/core/web/normalizeUrl'

describe('normalizeUrl', () => {
  it('returns https:// URLs unchanged', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })

  it('returns http:// URLs unchanged', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('prepends https:// when no scheme is given', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com')
  })

  it('handles paths without scheme', () => {
    expect(normalizeUrl('github.com/user/repo')).toBe('https://github.com/user/repo')
  })
})
