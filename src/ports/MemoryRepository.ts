import type { MemoryEntry, NewMemoryEntry, UpdateMemoryEntry } from '../core/memory/MemoryEntry'

export interface MemoryRepository {
  list: (projectPath: string) => Promise<MemoryEntry[]>
  create: (projectPath: string, entry: NewMemoryEntry) => Promise<MemoryEntry>
  update: (projectPath: string, id: string, patch: UpdateMemoryEntry) => Promise<MemoryEntry | null>
  remove: (projectPath: string, id: string) => Promise<boolean>
}
