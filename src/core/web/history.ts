export interface HistoryEntry {
  url: string
  visitedAt: number
}

export function addHistory(history: HistoryEntry[], url: string, at: number, limit = 200): HistoryEntry[] {
  const without = history.filter(h => h.url !== url)
  return [{ url, visitedAt: at }, ...without].slice(0, limit)
}

export function searchHistory(history: HistoryEntry[], query: string, limit = 8): HistoryEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return history.filter(h => h.url.toLowerCase().includes(q)).slice(0, limit)
}
