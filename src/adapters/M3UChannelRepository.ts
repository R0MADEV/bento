import type { ChannelRepository } from '../ports/ChannelRepository'
import type { ChannelData, Category, Country, Channel } from '../core/channel/Channel'
import { parseM3U } from '../core/channel/parseM3U'

// Lee una playlist M3U (texto, bundled con la app) y la adapta al modelo de Bento.
export class M3UChannelRepository implements ChannelRepository {
  constructor(private readonly m3uText: string) {}

  async fetchAll(): Promise<ChannelData> {
    const channels = parseM3U(this.m3uText)
    return {
      channels,
      categories: this.categoriesFrom(channels),
      countries: this.zonesFrom(channels),
    }
  }

  private categoriesFrom(channels: Channel[]): Category[] {
    const groups = new Set(channels.flatMap(c => c.categories))
    return [...groups].sort().map(g => ({ id: g, name: g }))
  }

  // La "zona" geográfica se reutiliza en el filtro de país (Channel.country)
  private zonesFrom(channels: Channel[]): Country[] {
    const zones = new Set(channels.map(c => c.country).filter(Boolean))
    return [...zones].sort().map(z => ({ code: z, name: z, flag: '' }))
  }
}
