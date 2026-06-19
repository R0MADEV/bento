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
    if (!url) {
      console.warn('[Player] canal sin stream:', channel.name)
      return
    }

    this.stop()

    console.log('[Player] hls.isSupported:', Hls.isSupported(), '| url:', url)

    if (Hls.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: false })
      this.hls.on(Hls.Events.ERROR, (_e, data) => console.error('[HLS]', data))
      this.hls.loadSource(url)
      this.hls.attachMedia(this.element)
    } else {
      // WebKit2GTK soporta HLS nativo (como Safari) sin necesitar MSE
      this.element.src = url
      this.element.load()
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
