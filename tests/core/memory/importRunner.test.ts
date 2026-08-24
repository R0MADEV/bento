import { describe, expect, it, vi } from 'vitest'
import { runCandidateImport } from '../../../src/core/memory/importRunner'
import type { ImportedMemoryCandidate } from '../../../src/core/memory/memorySource'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'
import type { MemoryRepository } from '../../../src/ports/MemoryRepository'

const candidate = (over: Partial<ImportedMemoryCandidate> = {}): ImportedMemoryCandidate => ({
  title: 'A title', summary: 'short', details: 'brief', source: 'claude',
  externalId: 'claude:new', createdAt: '2026-01-01T00:00:00.000Z', files: [], tags: [], ...over,
})

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'e1', projectPath: '/p', kind: 'note', title: 'A title', summary: 'short', details: 'brief',
  source: 'claude', externalId: 'claude:old', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

function repo(over: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async (_p: string, e) => entry({ id: 'created', ...e } as Partial<MemoryEntry>)),
    update: vi.fn(async (_p: string, id: string) => entry({ id })),
    remove: vi.fn(async () => true),
    ...over,
  } as MemoryRepository
}

describe('counting outcomes', () => {
  it('reports nothing done for no candidates', async () => {
    const r = repo()
    const out = await runCandidateImport(r, '/p', [], [])
    expect(out).toEqual({ saved: 0, merged: 0, skipped: 0, lastAffectedId: null })
    expect(r.create).not.toHaveBeenCalled()
  })

  it('creates what is new and names the last entry it touched', async () => {
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate()], [])
    expect(out).toMatchObject({ saved: 1, merged: 0, skipped: 0, lastAffectedId: 'created' })
    expect(r.create).toHaveBeenCalledTimes(1)
  })

  it('skips a candidate already imported, without writing', async () => {
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate({ externalId: 'claude:same' })],
      [entry({ id: 'kept', externalId: 'claude:same' })])
    expect(out).toMatchObject({ saved: 0, merged: 0, skipped: 1, lastAffectedId: 'kept' })
    expect(r.create).not.toHaveBeenCalled()
    expect(r.update).not.toHaveBeenCalled()
  })

  it('merges into a duplicate instead of creating a second copy', async () => {
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate()], [entry({ id: 'dup' })])
    expect(out).toMatchObject({ saved: 0, merged: 1, skipped: 0, lastAffectedId: 'dup' })
    expect(r.update).toHaveBeenCalledTimes(1)
    expect(r.create).not.toHaveBeenCalled()
  })

  it('falls back to the duplicate id when the update returns nothing', async () => {
    const r = repo({ update: vi.fn(async () => null) })
    const out = await runCandidateImport(r, '/p', [candidate()], [entry({ id: 'dup' })])
    expect(out.lastAffectedId).toBe('dup')
  })
})

describe('across several candidates', () => {
  it('sees what it just created, so a repeat is merged rather than duplicated', async () => {
    const r = repo()
    const twice = [candidate({ externalId: 'a' }), candidate({ externalId: 'b' })]
    const out = await runCandidateImport(r, '/p', twice, [])
    expect(out).toMatchObject({ saved: 1, merged: 1 })
  })

  it('leaves the caller-supplied list of existing entries alone', async () => {
    const existing: MemoryEntry[] = []
    await runCandidateImport(repo(), '/p', [candidate()], existing)
    expect(existing).toHaveLength(0)
  })
})

describe('the update stamp', () => {
  it('stamps each entry with what the resolver says for that candidate', async () => {
    const r = repo()
    await runCandidateImport(
      r, '/p',
      [candidate({ externalId: 'a', createdAt: '2020-05-05T00:00:00.000Z' })],
      [], undefined, c => c.createdAt,
    )
    const created = (r.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as { updatedAt: string }
    expect(created.updatedAt).toBe('2020-05-05T00:00:00.000Z')
  })

  it('stamps with now when no resolver is given', async () => {
    const before = Date.now()
    const r = repo()
    await runCandidateImport(r, '/p', [candidate()], [])
    const created = (r.create as ReturnType<typeof vi.fn>).mock.calls[0][1] as { updatedAt: string }
    expect(new Date(created.updatedAt).getTime()).toBeGreaterThanOrEqual(before)
  })
})

describe('progress', () => {
  it('reports each step in order', async () => {
    const seen: Array<[number, number]> = []
    await runCandidateImport(repo(), '/p',
      [candidate({ externalId: 'a' }), candidate({ externalId: 'b' })], [],
      (current, total) => seen.push([current, total]))
    expect(seen).toEqual([[1, 2], [2, 2]])
  })

  it('works without a progress callback', async () => {
    await expect(runCandidateImport(repo(), '/p', [candidate()], [])).resolves.toBeTruthy()
  })
})
