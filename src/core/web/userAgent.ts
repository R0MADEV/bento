export type UaMode = 'chrome' | 'default'

// Chrome UA so sites like WhatsApp don't reject the WKWebView engine.
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// null = no override → the webview keeps its native (Safari) UA, which some sites
// (e.g. Google login) prefer over a spoofed Chrome UA.
export function resolveUserAgent(mode: UaMode): string | null {
  return mode === 'chrome' ? CHROME_UA : null
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function getUaMode(prefs: Record<string, UaMode>, host: string): UaMode {
  return prefs[host] ?? 'chrome'
}

export function setUaMode(
  prefs: Record<string, UaMode>,
  host: string,
  mode: UaMode,
): Record<string, UaMode> {
  return { ...prefs, [host]: mode }
}
