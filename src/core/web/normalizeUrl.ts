export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  const hasScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://')
  return hasScheme ? trimmed : `https://${trimmed}`
}
