import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalStorageMemoryRepository } from '../../src/adapters/LocalStorageMemoryRepository'

const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

describe('LocalStorageMemoryRepository', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('localStorage', makeLocalStorage())
    vi.stubGlobal('crypto', { randomUUID: () => 'memory-1' })
  })

  it('stores entries by project', async () => {
    const repo = new LocalStorageMemoryRepository()
    await repo.create('/work/bento', { kind: 'decision', title: 'DB', summary: 'No SQLite' })
    await repo.create('/work/other', { kind: 'fact', title: 'Other', summary: 'Otro proyecto' })

    expect(await repo.list('/work/bento')).toHaveLength(1)
    expect(await repo.list('/work/other')).toHaveLength(1)
  })

  it('updates and removes entries', async () => {
    const repo = new LocalStorageMemoryRepository()
    const created = await repo.create('/work/bento', { kind: 'decision', title: 'DB', summary: 'No SQLite' })
    const updated = await repo.update('/work/bento', created.id, { summary: 'SQLite pendiente', tags: ['sqlite'] })

    expect(updated?.summary).toBe('SQLite pendiente')
    expect(updated?.tags).toEqual(['sqlite'])
    expect(await repo.remove('/work/bento', created.id)).toBe(true)
    expect(await repo.list('/work/bento')).toEqual([])
  })
})
