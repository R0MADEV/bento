import { t as i18nT } from '../../i18n'
import type { MemoryEntry } from '../../core/memory/MemoryEntry'
import { KIND_LABEL, sourceLabel } from '../../core/memory/memoryFormat'
import {
  MEMORY_PINNED_TAG, MEMORY_VERIFIED_TAG, isArchivedMemory,
} from '../../core/memory/normalize'

export interface MemoryListViewDeps {
  /** Empty when browsing every project's memory, which is then named per row. */
  currentProject: string
  getVisibleRows: () => MemoryEntry[]
  getSelectedId: () => string | null
  /** The multi-selection, shared with the bulk actions. */
  selectedIds: Set<string>
  setMiniItems: (items: Array<{ label: string; active: boolean; onClick: () => void }>) => void
  onSelect: (entry: MemoryEntry) => void
  onSelectionChanged: () => void
}

export interface MemoryListView {
  element: HTMLElement
  render: () => void
}

/** The list of stored memories: one row per entry, tickable for bulk actions. */
export function createMemoryListView(deps: MemoryListViewDeps): MemoryListView {
  const {
    currentProject, getVisibleRows, getSelectedId, selectedIds,
    setMiniItems, onSelect, onSelectionChanged,
  } = deps

  const list = document.createElement('div')
  list.className = 'memory-list'

  const render = (): void => {
    list.innerHTML = ''
    const rows = getVisibleRows()
    setMiniItems(rows.map(entry => ({
      label: entry.title || i18nT('memory.untitled'),
      active: entry.id === getSelectedId(),
      onClick: () => { onSelect(entry); render() },
    })))
    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'memory-empty'
      empty.textContent = i18nT('memory.thereIsNoSavedMemoryForThisFilter')
      list.appendChild(empty)
      return
    }
    rows.forEach(entry => {
      const item = document.createElement('div')
      item.className = entry.id === getSelectedId() ? 'memory-item active' : 'memory-item'
      const top = document.createElement('div')
      top.className = 'memory-item-top'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selectedIds.has(entry.id)
      checkbox.addEventListener('click', event => event.stopPropagation())
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(entry.id)
        else selectedIds.delete(entry.id)
        onSelectionChanged()
      })
      const badge = document.createElement('span')
      badge.className = `memory-kind ${entry.kind}`
      badge.textContent = KIND_LABEL[entry.kind]
      const entryTitle = document.createElement('span')
      entryTitle.className = 'memory-item-title'
      entryTitle.textContent = entry.title || i18nT('memory.untitled')
      const sourceBadge = document.createElement('span')
      sourceBadge.className = 'memory-source'
      sourceBadge.textContent = sourceLabel(entry.source)
      if (entry.tags.includes(MEMORY_PINNED_TAG)) item.classList.add('pinned')
      if (entry.tags.includes(MEMORY_VERIFIED_TAG)) item.classList.add('verified')
      if (isArchivedMemory(entry)) item.classList.add('archived')
      top.append(checkbox, badge, entryTitle, sourceBadge)
      const text = document.createElement('div')
      text.className = 'memory-item-summary'
      text.textContent = currentProject
        ? entry.summary || entry.details || i18nT('memory.noSummary')
        : `${entry.projectPath || i18nT('common.global')} · ${entry.summary || entry.details || i18nT('memory.noSummary')}`
      item.append(top, text)
      item.addEventListener('click', () => {
        onSelect(entry)
        render()
      })
      list.appendChild(item)
    })
  }

  return { element: list, render }
}
