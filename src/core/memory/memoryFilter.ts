import type { MemoryEntry, MemoryKind } from './MemoryEntry'
import { isArchivedMemory } from './normalize'
import { matchesMemoryQuery } from './memorySearch'

export interface MemoryFilter {
  query: string
  kind: MemoryKind | 'all'
  source: string
  includeArchived: boolean
}

/** The entries the list should show for the current filters. */
export const filterMemoryEntries = (entries: MemoryEntry[], filter: MemoryFilter): MemoryEntry[] =>
  entries.filter(entry => {
    if (!filter.includeArchived && isArchivedMemory(entry)) return false
    if (filter.kind !== 'all' && entry.kind !== filter.kind) return false
    if (filter.source !== 'all' && entry.source !== filter.source) return false
    return matchesMemoryQuery(entry, filter.query)
  })
