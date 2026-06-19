export interface Channel {
  id: string
  name: string
  logo: string
  country: string
  categories: string[]
  streamUrl?: string
}

export interface Stream {
  channel: string
  url: string
}
