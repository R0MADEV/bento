export function toggleFavorite(favorites: string[], id: string): string[] {
  return favorites.includes(id)
    ? favorites.filter(f => f !== id)
    : [...favorites, id]
}

export function isFavorite(favorites: string[], id: string): boolean {
  return favorites.includes(id)
}
