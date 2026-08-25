import { t as i18nT } from '../../i18n'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { MemoryEntry, NewMemoryEntry } from '../../core/memory/MemoryEntry'
import {
  MEMORY_ARCHIVED_TAG, archiveMemoryTags, toggleMemoryTag,
} from '../../core/memory/normalize'
import { mergeMemoryEntries } from '../../core/memory/dedup'
import type { MemoryRepository } from '../../ports/MemoryRepository'

export interface MemoryEntryActionsDeps {
  repo: MemoryRepository
  getEntries: () => MemoryEntry[]
  getSelectedId: () => string | null
  setSelectedId: (id: string | null) => void
  /** The multi-selection, shared with the list so both see the same set. */
  selectedIds: Set<string>
  reload: () => Promise<void>
  setStatus: (message?: string, entry?: MemoryEntry) => void
}

export interface MemoryEntryActions {
  archiveEntries: (rows: MemoryEntry[]) => Promise<void>
  deleteEntries: (rows: MemoryEntry[]) => Promise<void>
  mergeSelected: () => Promise<void>
  toggleSelectedTag: (tag: string) => Promise<void>
}

/** What the user can do to stored memories: archive, delete, merge and tag them. */
export function createMemoryEntryActions(deps: MemoryEntryActionsDeps): MemoryEntryActions {
  const { repo, getEntries, getSelectedId, setSelectedId, selectedIds, reload, setStatus } = deps

  const selectedEntry = (): MemoryEntry | undefined =>
    getEntries().find(entry => entry.id === getSelectedId())
  const selectedRows = (): MemoryEntry[] =>
    getEntries().filter(entry => selectedIds.has(entry.id))

  const toggleSelectedTag = async (tag: string): Promise<void> => {
    const entry = selectedEntry()
    if (!entry) return
    const updated = await repo.update(entry.projectPath, entry.id, { tags: toggleMemoryTag(entry, tag) })
    if (!updated) return
    setSelectedId(updated.id)
    await reload()
  }

  const updateEntry = async (entry: MemoryEntry, patch: Partial<NewMemoryEntry>): Promise<MemoryEntry | null> => (
    repo.update(entry.projectPath, entry.id, patch)
  )

  const archiveEntries = async (rows: MemoryEntry[]): Promise<void> => {
    if (!rows.length) return
    for (const entry of rows) {
      await updateEntry(entry, { tags: archiveMemoryTags(entry) })
      selectedIds.delete(entry.id)
    }
    await reload()
    setStatus(rows.length === 1 ? i18nT('memory.memoryArchived') : i18nT('memory.archivedCount', { count: rows.length }))
  }

  const deleteEntries = async (rows: MemoryEntry[]): Promise<void> => {
    if (!rows.length) return
    const confirmed = await askConfirm(
      rows.length === 1
        ? i18nT('memory.deleteOneQuestion', { title: rows[0].title || i18nT('memory.untitled2') })
        : i18nT('memory.deleteManyQuestion', { count: rows.length }),
      { title: i18nT('memory.deleteMemory'), kind: 'warning', okLabel: i18nT('common.delete'), cancelLabel: i18nT('common.cancel') },
    )
    if (!confirmed) return
    for (const entry of rows) {
      await repo.remove(entry.projectPath, entry.id)
      selectedIds.delete(entry.id)
      if (getSelectedId() === entry.id) setSelectedId(null)
    }
    await reload()
    setStatus(rows.length === 1 ? i18nT('memory.memoryDeleted') : i18nT('memory.deletedCount', { count: rows.length }))
  }

  const mergeSelected = async (): Promise<void> => {
    const rows = selectedRows()
    if (rows.length < 2) return
    const merged = await mergeMemoryEntries(rows)
    if (!merged) return
    const open = selectedEntry()
    const isOpenEntryPartOfTheMerge = Boolean(open) && selectedIds.has(open!.id)
    const target = isOpenEntryPartOfTheMerge ? open! : rows[0]
    const patch: Partial<NewMemoryEntry> = {
      kind: merged.kind,
      title: merged.title,
      summary: merged.summary,
      details: merged.details,
      tags: merged.tags.filter(tag => tag !== MEMORY_ARCHIVED_TAG),
      files: merged.files,
      source: merged.source,
      externalId: merged.externalId,
    }
    const saved = await repo.update(target.projectPath, target.id, patch)
    if (!saved) throw new Error('No se pudo fusionar la memoria principal.')
    for (const entry of rows) {
      if (entry.id !== target.id) await repo.remove(entry.projectPath, entry.id)
    }
    selectedIds.clear()
    setSelectedId(target.id)
    await reload()
    setStatus(i18nT('memory.mergedCount', { count: rows.length }), saved)
  }

  return { archiveEntries, deleteEntries, mergeSelected, toggleSelectedTag }
}
