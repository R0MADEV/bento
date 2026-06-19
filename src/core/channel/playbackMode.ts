export type PlaybackMode = 'native' | 'hls' | 'none'

// El WebView (WKWebView) reproduce HLS de forma nativa sin los problemas de
// red/CORS de hls.js al descargar segmentos. Por eso: nativo primero.
export function choosePlaybackMode(canPlayNative: boolean, hlsSupported: boolean): PlaybackMode {
  if (canPlayNative) return 'native'
  if (hlsSupported) return 'hls'
  return 'none'
}
