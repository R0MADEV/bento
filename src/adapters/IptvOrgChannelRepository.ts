import { invoke } from '@tauri-apps/api/core'
import type { ChannelRepository } from '../ports/ChannelRepository'
import type { ChannelData, RawChannel, Stream, Logo, Country, Category } from '../core/channel/Channel'
import { buildChannels } from '../core/channel/buildChannels'

const BASE = 'https://iptv-org.github.io/api'

export class IptvOrgChannelRepository implements ChannelRepository {
  async fetchAll(): Promise<ChannelData> {
    // streams es lo esencial; el resto enriquece y no bloquea si falla.
    const streams = await this.json<Stream[]>(`${BASE}/streams.json`)
    const channels = await this.json<RawChannel[]>(`${BASE}/channels.json`).catch(() => [] as RawChannel[])
    const logos = await this.json<Logo[]>(`${BASE}/logos.json`).catch(() => [] as Logo[])
    const countries = await this.json<Country[]>(`${BASE}/countries.json`).catch(() => [] as Country[])
    const categories = await this.json<Category[]>(`${BASE}/categories.json`).catch(() => [] as Category[])

    return { channels: buildChannels(streams, channels, logos), countries, categories }
  }

  // Descarga vía backend Rust (sin límites de red del WebView).
  private async json<T>(url: string): Promise<T> {
    const text = await invoke<string>('http_get', { url })
    return JSON.parse(text) as T
  }
}
