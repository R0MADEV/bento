import type { OpenApiEndpoint } from './openapi'

export interface Collection {
  id: string
  name: string
  endpoints: OpenApiEndpoint[]
}

// Add a collection, replacing any existing one with the same name (re-import updates).
export function addCollection(list: Collection[], collection: Collection): Collection[] {
  return [...list.filter(c => c.name !== collection.name), collection]
}

export function removeCollection(list: Collection[], id: string): Collection[] {
  return list.filter(c => c.id !== id)
}

export function renameCollection(list: Collection[], id: string, name: string): Collection[] {
  return list.map(c => (c.id === id ? { ...c, name } : c))
}
