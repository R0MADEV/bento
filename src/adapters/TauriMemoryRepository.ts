import { invoke } from '@tauri-apps/api/core'
import type { MemoryEntry, NewMemoryEntry, UpdateMemoryEntry } from '../core/memory/MemoryEntry'
import { normalizeMemoryPatch, normalizeNewMemoryEntry, normalizeProjectPath } from '../core/memory/normalize'
import type { MemoryRepository } from '../ports/MemoryRepository'
import { LocalStorageMemoryRepository } from './LocalStorageMemoryRepository'

const retryLocked = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('database is locked') || attempt >= 2) throw error
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
}

export class TauriMemoryRepository implements MemoryRepository {
  private readonly ready: Promise<void>

  constructor() {
    this.ready = this.migrateLocalStorage()
  }

  private async migrateLocalStorage(): Promise<void> {
    const legacy = new LocalStorageMemoryRepository().allEntries()
    if (!legacy.length) return
    await invoke('memory_migrate', { entries: legacy })
    localStorage.removeItem('bento.memory.entries.v1')
  }

  async list(projectPath: string): Promise<MemoryEntry[]> {
    await this.ready
    const normalizedProjectPath = normalizeProjectPath(projectPath)
    if (!normalizedProjectPath) return retryLocked(() => invoke<MemoryEntry[]>('memory_list_all'))
    return retryLocked(() => invoke<MemoryEntry[]>('memory_list', { projectPath: normalizedProjectPath }))
  }

  async create(projectPath: string, entry: NewMemoryEntry): Promise<MemoryEntry> {
    await this.ready
    const memory = normalizeNewMemoryEntry(projectPath, entry)
    return retryLocked(() => invoke<MemoryEntry>('memory_create', { entry: memory }))
  }

  async update(projectPath: string, id: string, patch: UpdateMemoryEntry): Promise<MemoryEntry | null> {
    await this.ready
    const normalized = normalizeMemoryPatch(patch)
    return retryLocked(() => invoke<MemoryEntry | null>('memory_update', {
      projectPath: normalizeProjectPath(projectPath), id, patch: normalized, updatedAt: new Date().toISOString(),
    }))
  }

  async remove(projectPath: string, id: string): Promise<boolean> {
    await this.ready
    return retryLocked(() => invoke<boolean>('memory_remove', { projectPath: normalizeProjectPath(projectPath), id }))
  }
}
