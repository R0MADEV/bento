import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { runCandidateImport } from '../../../src/core/memory/importRunner'
import type { ImportDecision } from '../../../src/core/memory/dedup'
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

// Qué es un duplicado lo decide `bento_memory::dedup`, que tiene sus propios
// tests. Aquí cada test dicta la decisión y se comprueba qué hace el runner con
// ella: cuántas cuenta, a quién escribe y en qué orden.
const decides = (...queue: ImportDecision[]): void => {
  let next = 0
  mocks.invoke.mockImplementation(async () => queue[Math.min(next++, queue.length - 1)])
}

const creates = (payload: Partial<MemoryEntry> = {}): ImportDecision =>
  ({ action: 'create', payload: entry({ id: 'new', ...payload }) })

function repo(over: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    list: vi.fn(async () => []),
    // El id lo pone el backend al guardar, no quien manda la entrada.
    create: vi.fn(async (_p: string, e) => entry({ ...e, id: 'created' } as Partial<MemoryEntry>)),
    update: vi.fn(async (_p: string, id: string) => entry({ id })),
    remove: vi.fn(async () => true),
    ...over,
  } as MemoryRepository
}

beforeEach(() => {
  mocks.invoke.mockReset()
  decides(creates())
})

describe('counting outcomes', () => {
  it('reports nothing done for no candidates', async () => {
    const r = repo()
    const out = await runCandidateImport(r, '/p', [], [])
    expect(out).toEqual({ saved: 0, merged: 0, skipped: 0, lastAffectedId: null })
    expect(r.create).not.toHaveBeenCalled()
  })

  it('creates what the planner says to create and names the last entry it touched', async () => {
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate()], [])
    expect(out).toMatchObject({ saved: 1, merged: 0, skipped: 0, lastAffectedId: 'created' })
    expect(r.create).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for a candidate the planner skips', async () => {
    decides({ action: 'skip', entryId: 'kept' })
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate()], [entry({ id: 'kept' })])
    expect(out).toMatchObject({ saved: 0, merged: 0, skipped: 1, lastAffectedId: 'kept' })
    expect(r.create).not.toHaveBeenCalled()
    expect(r.update).not.toHaveBeenCalled()
  })

  it('updates the duplicate instead of creating a second copy', async () => {
    const patch = { tags: ['x'], files: [], summary: 'short', details: 'brief' }
    decides({ action: 'merge', entry: entry({ id: 'dup' }), patch })
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate()], [entry({ id: 'dup' })])
    expect(out).toMatchObject({ saved: 0, merged: 1, skipped: 0, lastAffectedId: 'dup' })
    expect(r.update).toHaveBeenCalledWith('/p', 'dup', patch)
    expect(r.create).not.toHaveBeenCalled()
  })

  it('falls back to the duplicate id when the update returns nothing', async () => {
    decides({ action: 'merge', entry: entry({ id: 'dup' }), patch: { tags: [], files: [], summary: '', details: '' } })
    const r = repo({ update: vi.fn(async () => null) })
    const out = await runCandidateImport(r, '/p', [candidate()], [entry({ id: 'dup' })])
    expect(out.lastAffectedId).toBe('dup')
  })
})

describe('across several candidates', () => {
  it('shows the planner what it just created, so a repeat can be merged', async () => {
    decides(creates(), { action: 'merge', entry: entry({ id: 'created' }), patch: { tags: [], files: [], summary: '', details: '' } })
    const r = repo()
    const out = await runCandidateImport(r, '/p', [candidate({ externalId: 'a' }), candidate({ externalId: 'b' })], [])
    expect(out).toMatchObject({ saved: 1, merged: 1 })
    // La segunda decisión ya se toma contra la entrada recién creada.
    const second = mocks.invoke.mock.calls[1][1] as { existing: MemoryEntry[] }
    expect(second.existing.map(e => e.id)).toContain('created')
  })

  it('leaves the caller-supplied list of existing entries alone', async () => {
    const existing: MemoryEntry[] = []
    await runCandidateImport(repo(), '/p', [candidate()], existing)
    expect(existing).toHaveLength(0)
  })
})

describe('the update stamp', () => {
  it('passes on what the resolver says for that candidate', async () => {
    await runCandidateImport(
      repo(), '/p',
      [candidate({ externalId: 'a', createdAt: '2020-05-05T00:00:00.000Z' })],
      [], undefined, c => c.createdAt,
    )
    expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ updatedAt: '2020-05-05T00:00:00.000Z' })
  })

  it('lets the planner stamp with now when no resolver is given', async () => {
    const before = Date.now()
    await runCandidateImport(repo(), '/p', [candidate()], [])
    const { updatedAt } = mocks.invoke.mock.calls[0][1] as { updatedAt: string }
    expect(new Date(updatedAt).getTime()).toBeGreaterThanOrEqual(before)
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
