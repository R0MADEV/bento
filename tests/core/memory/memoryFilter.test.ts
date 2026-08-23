import { describe, expect, it } from 'vitest'
import { filterMemoryEntries, type MemoryFilter } from '../../../src/core/memory/memoryFilter'
import { MEMORY_ARCHIVED_TAG } from '../../../src/core/memory/normalize'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: '1', projectPath: '/p', kind: 'note', title: 'A title', summary: '', details: '',
  source: 'claude', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

const filter = (over: Partial<MemoryFilter> = {}): MemoryFilter =>
  ({ query: '', kind: 'all', source: 'all', includeArchived: false, ...over })

const ids = (rows: MemoryEntry[]): string[] => rows.map(r => r.id)

const ENTRIES = [
  entry({ id: 'a', kind: 'decision', source: 'claude', title: 'Chose SQLite' }),
  entry({ id: 'b', kind: 'note', source: 'codex', title: 'Random note' }),
  entry({ id: 'c', kind: 'note', source: 'claude', title: 'Old thing', tags: [MEMORY_ARCHIVED_TAG] }),
]

describe('defaults', () => {
  it('returns everything that is not archived', () => {
    expect(ids(filterMemoryEntries(ENTRIES, filter()))).toEqual(['a', 'b'])
  })

  it('includes archived entries when asked to', () => {
    expect(ids(filterMemoryEntries(ENTRIES, filter({ includeArchived: true })))).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty list for no entries', () => {
    expect(filterMemoryEntries([], filter())).toEqual([])
  })
})

describe('kind', () => {
  it('keeps only the chosen kind', () => {
    expect(ids(filterMemoryEntries(ENTRIES, filter({ kind: 'decision' })))).toEqual(['a'])
  })

  it('keeps every kind on "all"', () => {
    expect(filterMemoryEntries(ENTRIES, filter({ kind: 'all' }))).toHaveLength(2)
  })
})

describe('source', () => {
  it('keeps only the chosen source', () => {
    expect(ids(filterMemoryEntries(ENTRIES, filter({ source: 'codex' })))).toEqual(['b'])
  })

  it('keeps every source on "all"', () => {
    expect(filterMemoryEntries(ENTRIES, filter({ source: 'all' }))).toHaveLength(2)
  })
})

describe('query', () => {
  it('matches the text against the entry, case-insensitively', () => {
    expect(ids(filterMemoryEntries(ENTRIES, filter({ query: 'SQLITE' })))).toEqual(['a'])
  })

  it('keeps everything for an empty query', () => {
    expect(filterMemoryEntries(ENTRIES, filter({ query: '   ' }))).toHaveLength(2)
  })
})

describe('combining filters', () => {
  it('applies every filter at once', () => {
    const rows = filterMemoryEntries(ENTRIES, filter({ kind: 'note', source: 'claude', includeArchived: true }))
    expect(ids(rows)).toEqual(['c'])
  })

  it('can end up with nothing', () => {
    expect(filterMemoryEntries(ENTRIES, filter({ kind: 'decision', source: 'codex' }))).toEqual([])
  })

  it('excludes an archived entry even when it matches everything else', () => {
    expect(filterMemoryEntries(ENTRIES, filter({ query: 'Old thing' }))).toEqual([])
  })
})
