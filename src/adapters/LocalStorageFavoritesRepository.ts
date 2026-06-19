import type { FavoritesRepository } from '../ports/FavoritesRepository'

const KEY = 'bento.tv.favorites'

export class LocalStorageFavoritesRepository implements FavoritesRepository {
  load(): string[] {
    try {
      const raw = localStorage.getItem(KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  save(ids: string[]): void {
    localStorage.setItem(KEY, JSON.stringify(ids))
  }
}
