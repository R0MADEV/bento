// Item reproducible que se muestra en el grid (deriva de un stream)
export interface Channel {
  id: string
  name: string
  logo: string
  country: string
  categories: string[]
  streamUrl: string
}

// Esquemas crudos de la API iptv-org
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
