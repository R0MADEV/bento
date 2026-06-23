export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  const hasScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://')
  return hasScheme ? trimmed : `https://${trimmed}`
}

// The URL to act on: the loaded page, or the typed-but-not-navigated value.
export function resolveTargetUrl(currentUrl: string, inputValue: string): string {
  if (currentUrl) return currentUrl
  const trimmed = inputValue.trim()
  return trimmed ? normalizeUrl(trimmed) : ''
}
