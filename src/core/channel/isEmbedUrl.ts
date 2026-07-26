const EMBED_HOSTS = [
  'dailymotion.com/player',
  'youtube.com/embed',
  'youtube.com/watch',
  'player.twitch.tv',
  'player.vimeo.com',
]

// Distinguishes an embedded player page (iframe) from a direct stream.
export function isEmbedUrl(url: string): boolean {
  return EMBED_HOSTS.some(host => url.includes(host)) || url.endsWith('.html')
}
