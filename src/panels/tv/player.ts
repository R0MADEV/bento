import Hls from 'hls.js'
import type { Channel } from '../../core/channel/Channel'

export class HLSPlayer {
  private hls: Hls | null = null
  readonly element: HTMLVideoElement

  constructor() {
    this.element = document.createElement('video')
    this.element.className = 'tv-player'
    this.element.controls = true
    this.element.autoplay = true
  }

  play(channel: Channel): void {
    const url = channel.streamUrl
    if (!url) return

    this.stop()

    if (Hls.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: false })
      this.hls.loadSource(url)
      this.hls.attachMedia(this.element)
    } else if (this.element.canPlayType('application/vnd.apple.mpegurl')) {
      this.element.src = url
    }
  }

  stop(): void {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    this.element.src = ''
  }

  dispose(): void {
    this.stop()
  }
}
