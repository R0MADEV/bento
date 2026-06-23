import { describe, it, expect } from 'vitest'
import { parseOsc7Path, toDisplayPath } from '../../../src/core/terminal/osc7'

describe('parseOsc7Path', () => {
  it('extracts the absolute path from an OSC 7 file URL', () => {
    expect(parseOsc7Path('file://host/Users/roman/Desktop/izar')).toBe('/Users/roman/Desktop/izar')
  })

  it('decodes percent-encoded characters', () => {
    expect(parseOsc7Path('file:///Users/roman/a%20b')).toBe('/Users/roman/a b')
  })

  it('returns null for an unparseable value', () => {
    expect(parseOsc7Path('not a url')).toBeNull()
    expect(parseOsc7Path('')).toBeNull()
  })
})

describe('toDisplayPath', () => {
  it('collapses the macOS home prefix to ~', () => {
    expect(toDisplayPath('/Users/roman/Desktop/izar')).toBe('~/Desktop/izar')
  })

  it('collapses the Linux home prefix to ~', () => {
    expect(toDisplayPath('/home/roman/projects')).toBe('~/projects')
  })

  it('leaves paths outside home untouched', () => {
    expect(toDisplayPath('/opt/tools')).toBe('/opt/tools')
  })
})
