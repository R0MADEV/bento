import { describe, it, expect } from 'vitest'
import { isEmbedUrl } from '../../../src/core/channel/isEmbedUrl'

describe('isEmbedUrl', () => {
  it('detects Dailymotion player embeds', () => {
    expect(isEmbedUrl('https://geo.dailymotion.com/player/x14ru6.html?video=xa63dow')).toBe(true)
  })

  it('detects YouTube and Twitch embeds', () => {
    expect(isEmbedUrl('https://www.youtube.com/embed/abc')).toBe(true)
    expect(isEmbedUrl('https://player.twitch.tv/?channel=x')).toBe(true)
  })

  it('treats m3u8/mp4 streams as NOT embed', () => {
    expect(isEmbedUrl('https://cdn/live/index.m3u8')).toBe(false)
    expect(isEmbedUrl('https://cdn/master.m3u8?token=1')).toBe(false)
    expect(isEmbedUrl('https://cdn/video.mp4')).toBe(false)
  })
})
