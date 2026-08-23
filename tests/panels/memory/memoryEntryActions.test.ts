// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({ askConfirm: vi.fn(async () => true) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.askConfirm }))

import { createMemoryEntryActions } from '../../../src/panels/memory/memoryEntryActions'
import { MEMORY_ARCHIVED_TAG, MEMORY_PINNED_TAG } from '../../../src/core/memory/normalize'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'
import type { MemoryRepository } from '../../../src/ports/MemoryRepository'

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'e1', projectPath: '/p', kind: 'note', title: 'A title', summary: 's', details: 'd',
  source: 'manual', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

function repo(over: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async () => entry()),
    update: vi.fn(async (_p: string, id: string) => entry({ id })),
    remove: vi.fn(async () => true),
    ...over,
  } as MemoryRepository
}

function setup(over: { repo?: MemoryRepository; entries?: MemoryEntry[]; selectedId?: string | null } = {}) {
  const state = {
    entries: over.entries ?? [entry()],
    selectedId: over.selectedId ?? null as string | null,
    selectedIds: new Set<string>(),
    reloads: 0,
    statuses: [] as string[],
  }
  const r = over.repo ?? repo()
  const actions = createMemoryEntryActions({
    repo: r,
    getEntries: () => state.entries,
    getSelectedId: () => state.selectedId,
    setSelectedId: id => { state.selectedId = id },
    selectedIds: state.selectedIds,
    reload: async () => { state.reloads++ },
    setStatus: (message, _e) => { state.statuses.push(message ?? '') },
  })
  return { actions, state, repo: r }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.askConfirm.mockReset()
  mocks.askConfirm.mockResolvedValue(true)
})

describe('archiveEntries', () => {
  it('does nothing for an empty selection', async () => {
    const { actions, repo: r, state } = setup()
    await actions.archiveEntries([])
    expect(r.update).not.toHaveBeenCalled()
    expect(state.reloads).toBe(0)
  })

  it('tags each row as archived and drops it from the selection', async () => {
    const rows = [entry({ id: 'a' }), entry({ id: 'b' })]
    const { actions, repo: r, state } = setup({ entries: rows })
    state.selectedIds.add('a')
    state.selectedIds.add('b')
    await actions.archiveEntries(rows)
    expect(r.update).toHaveBeenCalledTimes(2)
    expect((r.update as ReturnType<typeof vi.fn>).mock.calls[0][2].tags).toContain(MEMORY_ARCHIVED_TAG)
    expect(state.selectedIds.size).toBe(0)
    expect(state.reloads).toBe(1)
  })

  it('reports one archived differently from several', async () => {
    const { actions, state } = setup()
    await actions.archiveEntries([entry()])
    const single = state.statuses.at(-1)
    await actions.archiveEntries([entry({ id: 'a' }), entry({ id: 'b' })])
    expect(state.statuses.at(-1)).not.toBe(single)
  })
})

describe('deleteEntries', () => {
  it('does nothing for an empty selection, without asking', async () => {
    const { actions, repo: r } = setup()
    await actions.deleteEntries([])
    expect(mocks.askConfirm).not.toHaveBeenCalled()
    expect(r.remove).not.toHaveBeenCalled()
  })

  it('asks first and removes on confirmation', async () => {
    const rows = [entry({ id: 'a' }), entry({ id: 'b' })]
    const { actions, repo: r, state } = setup({ entries: rows })
    await actions.deleteEntries(rows)
    expect(mocks.askConfirm).toHaveBeenCalledTimes(1)
    expect(r.remove).toHaveBeenCalledTimes(2)
    expect(state.reloads).toBe(1)
  })

  it('removes nothing when the confirmation is refused', async () => {
    mocks.askConfirm.mockResolvedValue(false)
    const { actions, repo: r, state } = setup()
    await actions.deleteEntries([entry()])
    expect(r.remove).not.toHaveBeenCalled()
    expect(state.reloads).toBe(0)
  })

  it('clears the selection when the deleted entry was the selected one', async () => {
    const { actions, state } = setup({ selectedId: 'a' })
    state.selectedIds.add('a')
    await actions.deleteEntries([entry({ id: 'a' })])
    expect(state.selectedId).toBeNull()
    expect(state.selectedIds.size).toBe(0)
  })

  it('leaves the selection alone when another entry is deleted', async () => {
    const { actions, state } = setup({ selectedId: 'keep' })
    await actions.deleteEntries([entry({ id: 'other' })])
    expect(state.selectedId).toBe('keep')
  })
})

describe('mergeSelected', () => {
  const twoSelected = (selectedId: string | null = null) => {
    const rows = [entry({ id: 'a', title: 'First' }), entry({ id: 'b', title: 'Second' })]
    const s = setup({ entries: rows, selectedId })
    s.state.selectedIds.add('a')
    s.state.selectedIds.add('b')
    return s
  }

  it('needs at least two entries', async () => {
    const { actions, repo: r, state } = setup()
    state.selectedIds.add('e1')
    await actions.mergeSelected()
    expect(r.update).not.toHaveBeenCalled()
  })

  it('merges into the first row when nothing is selected in the detail pane', async () => {
    const { actions, repo: r } = twoSelected(null)
    await actions.mergeSelected()
    expect((r.update as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('a')
  })

  it('merges into the entry open in the detail pane when it is one of them', async () => {
    const { actions, repo: r } = twoSelected('b')
    await actions.mergeSelected()
    expect((r.update as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('b')
  })

  it('ignores a detail entry that is not part of the selection', async () => {
    const { actions, repo: r } = twoSelected('elsewhere')
    await actions.mergeSelected()
    expect((r.update as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('a')
  })

  it('removes the rows it folded in and keeps the target', async () => {
    const { actions, repo: r } = twoSelected(null)
    await actions.mergeSelected()
    expect(r.remove).toHaveBeenCalledTimes(1)
    expect((r.remove as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('b')
  })

  it('never carries the archived tag into the merged entry', async () => {
    const rows = [entry({ id: 'a', tags: [MEMORY_ARCHIVED_TAG, 'keep'] }), entry({ id: 'b' })]
    const s = setup({ entries: rows })
    s.state.selectedIds.add('a')
    s.state.selectedIds.add('b')
    await s.actions.mergeSelected()
    const patch = (s.repo.update as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(patch.tags).not.toContain(MEMORY_ARCHIVED_TAG)
    expect(patch.tags).toContain('keep')
  })

  it('selects the merged entry and clears the multi-selection', async () => {
    const { actions, state } = twoSelected(null)
    await actions.mergeSelected()
    expect(state.selectedId).toBe('a')
    expect(state.selectedIds.size).toBe(0)
  })

  it('fails loudly when the merge cannot be saved', async () => {
    const rows = [entry({ id: 'a' }), entry({ id: 'b' })]
    const s = setup({ entries: rows, repo: repo({ update: vi.fn(async () => null) }) })
    s.state.selectedIds.add('a')
    s.state.selectedIds.add('b')
    await expect(s.actions.mergeSelected()).rejects.toThrow()
    expect(s.repo.remove).not.toHaveBeenCalled()
  })
})

describe('toggleSelectedTag', () => {
  it('does nothing when no entry is open', async () => {
    const { actions, repo: r } = setup({ selectedId: null })
    await actions.toggleSelectedTag(MEMORY_PINNED_TAG)
    expect(r.update).not.toHaveBeenCalled()
  })

  it('adds the tag when it is absent and removes it when present', async () => {
    const { actions, repo: r } = setup({ entries: [entry({ id: 'e1' })], selectedId: 'e1' })
    await actions.toggleSelectedTag(MEMORY_PINNED_TAG)
    expect((r.update as ReturnType<typeof vi.fn>).mock.calls[0][2].tags).toContain(MEMORY_PINNED_TAG)

    const pinned = setup({ entries: [entry({ id: 'e1', tags: [MEMORY_PINNED_TAG] })], selectedId: 'e1' })
    await pinned.actions.toggleSelectedTag(MEMORY_PINNED_TAG)
    expect((pinned.repo.update as ReturnType<typeof vi.fn>).mock.calls[0][2].tags).not.toContain(MEMORY_PINNED_TAG)
  })

  it('does not reload when the update returns nothing', async () => {
    const { actions, state } = setup({
      entries: [entry({ id: 'e1' })], selectedId: 'e1', repo: repo({ update: vi.fn(async () => null) }),
    })
    await actions.toggleSelectedTag(MEMORY_PINNED_TAG)
    expect(state.reloads).toBe(0)
  })
})
