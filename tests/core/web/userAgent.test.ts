import { describe, it, expect } from 'vitest'
import { resolveUserAgent, hostOf, getUaMode, setUaMode, CHROME_UA } from '../../../src/core/web/userAgent'

describe('resolveUserAgent', () => {
  it('returns the Chrome UA for chrome mode', () => {
    expect(resolveUserAgent('chrome')).toBe(CHROME_UA)
  })

  it('returns null for default mode (let the webview use its native Safari UA)', () => {
    expect(resolveUserAgent('default')).toBeNull()
  })
})

describe('hostOf', () => {
  it('extracts the host from a URL', () => {
    expect(hostOf('https://web.whatsapp.com/some/path')).toBe('web.whatsapp.com')
  })

  it('returns empty string for an unparseable URL', () => {
    expect(hostOf('not a url')).toBe('')
  })
})

describe('getUaMode', () => {
  it('defaults to chrome when the host has no stored preference', () => {
    expect(getUaMode({}, 'example.com')).toBe('chrome')
  })

  it('returns the stored mode for a known host', () => {
    expect(getUaMode({ 'accounts.google.com': 'default' }, 'accounts.google.com')).toBe('default')
  })
})

describe('setUaMode', () => {
  it('sets the mode for a host without mutating the original', () => {
    const prefs = {}
    const next = setUaMode(prefs, 'example.com', 'default')
    expect(next).toEqual({ 'example.com': 'default' })
    expect(prefs).toEqual({})
  })

  it('overwrites an existing host mode', () => {
    const next = setUaMode({ 'a.com': 'chrome' }, 'a.com', 'default')
    expect(next).toEqual({ 'a.com': 'default' })
  })
})
