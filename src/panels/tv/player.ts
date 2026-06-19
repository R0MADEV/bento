import Hls from 'hls.js'
import type { Channel } from '../../core/channel/Channel'
import { choosePlaybackMode } from '../../core/channel/playbackMode'
import { pickSubtitleTrack } from '../../core/channel/pickSubtitleTrack'

export type PlayerStatus = 'loading' | 'playing' | 'error'

export class HLSPlayer {
  private hls: Hls | null = null
  readonly element: HTMLVideoElement
  onStatus?: (status: PlayerStatus) => void

  constructor() {
    this.element = document.createElement('video')
    this.element.className = 'tv-player'
    this.element.controls = true
    this.element.autoplay = true

    this.element.addEventListener('playing', () => this.onStatus?.('playing'))
    this.element.addEventListener('error', () => this.onStatus?.('error'))
    // Cuando el stream añade pistas de subtítulos, prefiere la española
    this.element.textTracks.addEventListener('addtrack', () => this.preferSpanishSubtitles())
  }

  private preferSpanishSubtitles(): void {
    const tracks = Array.from(this.element.textTracks)
    const index = pickSubtitleTrack(tracks.map(t => t.language || ''), 'es')
    if (index < 0) return
    tracks.forEach((t, i) => { t.mode = i === index ? 'showing' : 'disabled' })
  }

  play(channel: Channel): void {
    const url = channel.streamUrl
    if (!url) return

    this.stop()
    this.onStatus?.('loading')

    const canPlayNative = Boolean(this.element.canPlayType('application/vnd.apple.mpegurl'))
    const mode = choosePlaybackMode(canPlayNative, Hls.isSupported())

    if (mode === 'native') {
      this.element.src = url
      this.element.load()
      this.element.play().catch(() => {})
    } else if (mode === 'hls') {
      this.hls = new Hls({ lowLatencyMode: false })
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) this.onStatus?.('error')
      })
      this.hls.loadSource(url)
      this.hls.attachMedia(this.element)
    } else {
      this.onStatus?.('error')
    }
  }

  async togglePiP(): Promise<void> {
    if (!('pictureInPictureEnabled' in document)) return
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture()
      return
    }
    await this.element.requestPictureInPicture()
  }

  stop(): void {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    this.element.removeAttribute('src')
    this.element.load()
  }

  dispose(): void {
    this.stop()
  }
}
