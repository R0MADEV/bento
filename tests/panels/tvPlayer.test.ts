// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { HLSPlayer } from '../../src/panels/tv/player'

describe('HLSPlayer embedded playback lifecycle', () => {
  it('unloads a third-party iframe while hidden and restores it when visible', async () => {
    const player = new HLSPlayer()
    const streamUrl = 'https://www.youtube.com/embed/example'
    await player.play({
      id: 'example',
      name: 'Example',
      logo: '',
      country: '',
      categories: [],
      streamUrl,
    })

    const iframe = player.element.querySelector('iframe')!
    expect(iframe.getAttribute('src')).toBe(streamUrl)

    player.pause()
    expect(iframe.hasAttribute('src')).toBe(false)

    player.resume()
    expect(iframe.getAttribute('src')).toBe(streamUrl)

    player.dispose()
    expect(iframe.hasAttribute('src')).toBe(false)
  })
})
