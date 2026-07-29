import type { MemoryEntry, NewMemoryEntry, UpdateMemoryEntry } from '../core/memory/MemoryEntry'
import { normalizeMemoryPatch, normalizeNewMemoryEntry, normalizeProjectPath } from '../core/memory/normalize'
import type { MemoryRepository } from '../ports/MemoryRepository'
import { sortMemoryEntries } from '../core/memory/memorySearch'

const KEY = 'bento.memory.entries.v1'
const projectKey = (projectPath: string): string => normalizeProjectPath(projectPath) || '__global__'

export class LocalStorageMemoryRepository implements MemoryRepository {
  private loadAll(): Record<string, MemoryEntry[]> {
    try {
      const raw = localStorage.getItem(KEY)
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }

  private saveAll(data: Record<string, MemoryEntry[]>): void {
    localStorage.setItem(KEY, JSON.stringify(data))
  }

  allEntries(): MemoryEntry[] {
    return Object.values(this.loadAll()).flat()
  }

  async list(projectPath: string): Promise<MemoryEntry[]> {
    const all = this.loadAll()
    return sortMemoryEntries(all[projectKey(projectPath)] ?? [])
  }

  async create(projectPath: string, entry: NewMemoryEntry): Promise<MemoryEntry> {
    const all = this.loadAll()
    const key = projectKey(projectPath)
    const created = normalizeNewMemoryEntry(projectPath, entry)
    all[key] = sortMemoryEntries([created, ...(all[key] ?? [])])
    this.saveAll(all)
    return created
  }

  async update(projectPath: string, id: string, patch: UpdateMemoryEntry): Promise<MemoryEntry | null> {
    const all = this.loadAll()
    const key = projectKey(projectPath)
    const entries = all[key] ?? []
    const index = entries.findIndex(entry => entry.id === id)
    if (index < 0) return null
    const current = entries[index]
    const normalized = normalizeMemoryPatch(patch)
    const next: MemoryEntry = {
      ...current,
      kind: normalized.kind ?? current.kind,
      title: normalized.title === undefined ? current.title : normalized.title,
      summary: normalized.summary === undefined ? current.summary : normalized.summary,
      details: normalized.details === undefined ? current.details : normalized.details,
      tags: normalized.tags === undefined ? current.tags : normalized.tags,
      files: normalized.files === undefined ? current.files : normalized.files,
      source: normalized.source === undefined ? current.source : normalized.source,
      externalId: normalized.externalId === undefined ? current.externalId : normalized.externalId,
      updatedAt: new Date().toISOString(),
    }
    entries[index] = next
    all[key] = sortMemoryEntries(entries)
    this.saveAll(all)
    return next
  }

  async remove(projectPath: string, id: string): Promise<boolean> {
    const all = this.loadAll()
    const key = projectKey(projectPath)
    const entries = all[key] ?? []
    const next = entries.filter(entry => entry.id !== id)
    if (next.length === entries.length) return false
    all[key] = next
    this.saveAll(all)
    return true
  }
}
