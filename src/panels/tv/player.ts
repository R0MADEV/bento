import type Hls from 'hls.js'
import type { Channel } from '../../core/channel/Channel'
import { choosePlaybackMode } from '../../core/channel/playbackMode'
import { pickSubtitleTrack } from '../../core/channel/pickSubtitleTrack'
import { isEmbedUrl } from '../../core/channel/isEmbedUrl'

export type PlayerStatus = 'loading' | 'playing' | 'error'

export class HLSPlayer {
  private hls: Hls | null = null
  readonly element: HTMLDivElement
  private readonly video: HTMLVideoElement
  private readonly iframe: HTMLIFrameElement
  onStatus?: (status: PlayerStatus) => void

  constructor() {
    this.element = document.createElement('div')
    this.element.className = 'tv-player'

    this.video = document.createElement('video')
    this.video.className = 'tv-video'
    this.video.controls = true
    this.video.autoplay = true

    this.iframe = document.createElement('iframe')
    this.iframe.className = 'tv-iframe hidden'
    this.iframe.allow = 'autoplay; fullscreen; picture-in-picture'
    this.iframe.setAttribute('allowfullscreen', 'true')

    this.element.append(this.video, this.iframe)

    this.video.addEventListener('playing', () => this.onStatus?.('playing'))
    this.video.addEventListener('error', () => this.onStatus?.('error'))
    this.video.textTracks.addEventListener('addtrack', () => this.preferSpanishSubtitles())
  }

  async play(channel: Channel): Promise<void> {
    const url = channel.streamUrl
    if (!url) return

    this.stop()
    this.onStatus?.('loading')

    if (isEmbedUrl(url)) {
      this.video.classList.add('hidden')
      this.iframe.classList.remove('hidden')
      this.iframe.src = url
      this.onStatus?.('playing')
      return
    }

    this.iframe.classList.add('hidden')
    this.video.classList.remove('hidden')

    // The WebView plays HLS natively: in that case we do NOT load hls.js
    // (so the heavy chunk is only downloaded when it's actually needed).
    const canPlayNative = Boolean(this.video.canPlayType('application/vnd.apple.mpegurl'))
    if (canPlayNative) {
      this.video.src = url
      this.video.load()
      this.video.play().catch(() => {})
      return
    }

    try {
      const { default: Hls } = await import('hls.js')
      const mode = choosePlaybackMode(canPlayNative, Hls.isSupported())
      if (mode !== 'hls') { this.onStatus?.('error'); return }
      this.hls = new Hls({ lowLatencyMode: false, maxBufferLength: 10, maxMaxBufferLength: 20 })
      this.hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) this.onStatus?.('error') })
      this.hls.loadSource(url)
      this.hls.attachMedia(this.video)
    } catch {
      this.onStatus?.('error')
    }
  }

  private preferSpanishSubtitles(): void {
    const tracks = Array.from(this.video.textTracks)
    const index = pickSubtitleTrack(tracks.map(t => t.language || ''), 'es')
    if (index < 0) return
    tracks.forEach((t, i) => { t.mode = i === index ? 'showing' : 'disabled' })
  }

  get isInPiP(): boolean {
    return document.pictureInPictureElement === this.video
  }

  pause(): void {
    this.video.pause()
    this.hls?.stopLoad()
  }

  resume(): void {
    if (this.video.classList.contains('hidden') || !this.video.src) return
    this.hls?.startLoad()
    this.video.play().catch(() => {})
  }

  async pip(): Promise<void> {
    if (this.video.classList.contains('hidden')) throw new Error('pip-not-video')
    if (document.pictureInPictureElement === this.video) {
      await document.exitPictureInPicture()
    } else {
      await this.video.requestPictureInPicture()
    }
  }

  stop(): void {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    this.video.removeAttribute('src')
    this.video.load()
    this.iframe.removeAttribute('src')
  }

  dispose(): void {
    this.stop()
  }
}
