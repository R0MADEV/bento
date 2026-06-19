import { invoke } from '@tauri-apps/api/core'
import type { ChannelRepository } from '../ports/ChannelRepository'
import type { Channel, RawChannel, Stream, Logo } from '../core/channel/Channel'
import { buildChannels } from '../core/channel/buildChannels'

const BASE = 'https://iptv-org.github.io/api'

export class IptvOrgChannelRepository implements ChannelRepository {
  async fetchAll(): Promise<Channel[]> {
    // streams es lo esencial (3MB): cada uno es reproducible.
    const streams = await this.json<Stream[]>(`${BASE}/streams.json`)
    // channels (10MB) y logos solo enriquecen: si fallan, seguimos sin ellos.
    const channels = await this.json<RawChannel[]>(`${BASE}/channels.json`).catch(() => [] as RawChannel[])
    const logos = await this.json<Logo[]>(`${BASE}/logos.json`).catch(() => [] as Logo[])
    return buildChannels(streams, channels, logos)
  }

  // Descarga vía backend Rust (sin límites de red del WebView).
  private async json<T>(url: string): Promise<T> {
    const text = await invoke<string>('http_get', { url })
    return JSON.parse(text) as T
  }
}
