// Playable item shown in the grid (derived from a stream)
export interface Channel {
  id: string
  name: string
  logo: string
  country: string
  categories: string[]
  streamUrl: string
}

// Raw schemas from the iptv-org API
export interface RawChannel {
  id: string
  name: string
  country: string
  categories: string[]
}

export interface Stream {
  channel: string | null
  title: string | null
  url: string
}

export interface Logo {
  channel: string | null
  url: string
}

export interface Country {
  code: string
  name: string
  flag: string
}

export interface Category {
  id: string
  name: string
}

// Full repository result: channels + metadata for the filters
export interface ChannelData {
  channels: Channel[]
  countries: Country[]
  categories: Category[]
}
