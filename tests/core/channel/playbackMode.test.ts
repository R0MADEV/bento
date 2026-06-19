import { describe, it, expect } from 'vitest'
import { choosePlaybackMode } from '../../../src/core/channel/playbackMode'

describe('choosePlaybackMode', () => {
  it('prefers native HLS when the video can play it (WKWebView/Safari)', () => {
    expect(choosePlaybackMode(true, true)).toBe('native')
    expect(choosePlaybackMode(true, false)).toBe('native')
  })

  it('falls back to hls.js only when native is not available', () => {
    expect(choosePlaybackMode(false, true)).toBe('hls')
  })

  it('returns none when neither is available', () => {
    expect(choosePlaybackMode(false, false)).toBe('none')
  })
})
