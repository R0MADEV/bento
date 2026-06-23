import { describe, it, expect } from 'vitest'
import { normalizeUrl, resolveTargetUrl } from '../../../src/core/web/normalizeUrl'

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

describe('resolveTargetUrl', () => {
  it('prefers the loaded url', () => {
    expect(resolveTargetUrl('https://loaded.com', 'typed.com')).toBe('https://loaded.com')
  })

  it('falls back to the normalized typed value when nothing is loaded', () => {
    expect(resolveTargetUrl('', 'example.com')).toBe('https://example.com')
  })

  it('returns empty string when nothing is loaded and the input is blank', () => {
    expect(resolveTargetUrl('', '   ')).toBe('')
  })
})
