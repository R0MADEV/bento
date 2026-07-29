import type { MemoryEntry } from './MemoryEntry'

const normalize = (value: string): string => value.trim().toLowerCase()

export function matchesMemoryQuery(entry: MemoryEntry, query: string): boolean {
  const q = normalize(query)
  if (!q) return true
  return [
    entry.kind,
    entry.title,
    entry.summary,
    entry.details,
    entry.source,
    ...entry.tags,
    ...entry.files,
  ]
    .join(' ')
    .toLowerCase()
    .includes(q)
}

export function sortMemoryEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt)
    return byUpdated || b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title)
  })
}
