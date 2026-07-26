export type PlaybackMode = 'native' | 'hls' | 'none'

// The WebView (WKWebView) plays HLS natively without hls.js's network/CORS
// problems when downloading segments. Hence: native first.
export function choosePlaybackMode(canPlayNative: boolean, hlsSupported: boolean): PlaybackMode {
  if (canPlayNative) return 'native'
  if (hlsSupported) return 'hls'
  return 'none'
}
