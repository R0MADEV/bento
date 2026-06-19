// HLS player wrapper — Fase 3
// TODO: Integrate hls.js for IPTV streaming

export class HLSPlayer {
  private video: HTMLVideoElement

  constructor(videoElement: HTMLVideoElement) {
    this.video = videoElement
  }

  play(url: string): void {
    // TODO: load m3u8 and play with hls.js
  }

  stop(): void {
    this.video.pause()
  }
}
