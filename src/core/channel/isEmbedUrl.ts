const EMBED_HOSTS = [
  'dailymotion.com/player',
  'youtube.com/embed',
  'youtube.com/watch',
  'player.twitch.tv',
  'player.vimeo.com',
]

// Distingue una página de reproductor embebido (iframe) de un stream directo.
export function isEmbedUrl(url: string): boolean {
  return EMBED_HOSTS.some(host => url.includes(host)) || url.endsWith('.html')
}
