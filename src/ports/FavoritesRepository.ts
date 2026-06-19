export interface FavoritesRepository {
  load: () => string[]
  save: (ids: string[]) => void
}
