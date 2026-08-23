import type { ParsedNote } from './noteFile'

export interface NoteEntry {
  name: string
  note: ParsedNote
}

export interface NoteGroup {
  category: string
  items: NoteEntry[]
}

const matchesQuery = (entry: NoteEntry, query: string): boolean => {
  if (!query) return true
  const haystack = `${entry.note.title} ${entry.note.category} ${entry.note.tags.join(' ')}`
  return haystack.toLowerCase().includes(query)
}

/**
 * Entries matching the search query, bucketed by category (blank ones under
 * the placeholder), categories kept in the order they first appear.
 */
export function groupNoteEntries(entries: NoteEntry[], search: string, uncategorizedLabel: string): NoteGroup[] {
  const query = search.trim().toLowerCase()
  const byCategory = new Map<string, NoteEntry[]>()
  for (const entry of entries) {
    if (!matchesQuery(entry, query)) continue
    const category = entry.note.category.trim() || uncategorizedLabel
    const items = byCategory.get(category) ?? []
    items.push(entry)
    byCategory.set(category, items)
  }
  return [...byCategory.entries()].map(([category, items]) => ({ category, items }))
}
