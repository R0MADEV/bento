import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import type { MemoryEntry, MemoryKind, NewMemoryEntry } from '../../core/memory/MemoryEntry'
import {
  MEMORY_PINNED_TAG,
  MEMORY_SUPERSEDED_TAG,
  MEMORY_VERIFIED_TAG,
  isArchivedMemory,
} from '../../core/memory/normalize'
import { filterMemoryEntries } from '../../core/memory/memoryFilter'
import {
  KIND_LABEL, KIND_OPTIONS, splitList,
  timeLabel, sourceLabel, canRegenerateSummary,
} from '../../core/memory/memoryFormat'
import { runCandidateImport } from './memoryImportRunner'
import { createMemoryEntryActions } from './memoryEntryActions'
import { createMemoryListView } from './memoryListView'
import { createMemorySourcesView } from './memorySourcesView'
import { createMemorySummaryJobsView } from './memorySummaryJobsView'
import type { ImportedMemoryCandidate } from '../../core/memory/memorySource'

import type { MemoryRepository } from '../../ports/MemoryRepository'

export function createMemoryPanel(repo: MemoryRepository, projectPath?: string): { element: HTMLElement } {
  // Shared with the list view and the bulk actions, so all three see one set.
  const selectedIds = new Set<string>()

  const root = document.createElement('div')
  root.className = 'memory-panel'

  const currentProject = projectPath?.trim() ?? ''
  const addBtn = document.createElement('button')
  addBtn.title = i18nT('memory.newEntry')
  addBtn.innerHTML = icon('plus')
  const importClaudeBtn = document.createElement('button')
  importClaudeBtn.title = i18nT('memory.importFromClaude')
  importClaudeBtn.innerHTML = icon('download')
  const importCodexBtn = document.createElement('button')
  importCodexBtn.title = i18nT('memory.importFromCodex')
  importCodexBtn.innerHTML = icon('code')
  const refreshBtn = document.createElement('button')
  refreshBtn.title = i18nT('memory.reloadMemory')
  refreshBtn.innerHTML = icon('refresh')

  const cs = createCollapsibleSidebar({
    storageKey: 'bento.memory.sidebar',
    title: i18nT('memory.memory'),
    defaultWidth: 300,
    minWidth: 220,
    minRemaining: 380,
    container: root,
  })
  cs.actions.append(addBtn, importClaudeBtn, importCodexBtn, refreshBtn)
  Object.assign(cs.list.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column' })

  const controls = document.createElement('div')
  controls.className = 'memory-controls'

  const search = document.createElement('input')
  search.className = 'memory-search'
  search.placeholder = i18nT('memory.searchByTextTagFile')

  const kindFilter = document.createElement('select')
  kindFilter.className = 'memory-filter'
  KIND_OPTIONS.forEach(value => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value === 'all' ? i18nT('memory.allTypes') : KIND_LABEL[value]
    kindFilter.appendChild(option)
  })

  const sourceFilter = document.createElement('select')
  sourceFilter.className = 'memory-filter'
  const archivedToggle = document.createElement('label')
  archivedToggle.className = 'memory-toggle'
  const archivedCheckbox = document.createElement('input')
  archivedCheckbox.type = 'checkbox'
  archivedToggle.append(archivedCheckbox, document.createTextNode('Ver archivadas'))

  const selectVisibleBtn = document.createElement('button')
  selectVisibleBtn.className = 'memory-action'
  selectVisibleBtn.textContent = i18nT('memory.selectVisible')
  const clearSelectionBtn = document.createElement('button')
  clearSelectionBtn.className = 'memory-action'
  clearSelectionBtn.textContent = i18nT('memory.clearSelection')
  const archiveSelectedBtn = document.createElement('button')
  archiveSelectedBtn.className = 'memory-action'
  archiveSelectedBtn.textContent = i18nT('memory.archive')
  const mergeSelectedBtn = document.createElement('button')
  mergeSelectedBtn.className = 'memory-action'
  mergeSelectedBtn.textContent = i18nT('memory.merge')
  const deleteSelectedBtn = document.createElement('button')
  deleteSelectedBtn.className = 'memory-action danger'
  deleteSelectedBtn.textContent = i18nT('common.delete2')
  controls.append(search, kindFilter, sourceFilter, archivedToggle, selectVisibleBtn, clearSelectionBtn, archiveSelectedBtn, mergeSelectedBtn, deleteSelectedBtn)

  const listView = createMemoryListView({
    currentProject,
    getVisibleRows: () => visibleRows(),
    getSelectedId: () => selectedId,
    selectedIds,
    setMiniItems: itemsToShow => cs.setMiniItems(itemsToShow),
    onSelect: entry => { selectedId = entry.id; fillForm(entry) },
    onSelectionChanged: () => syncBulkButtons(),
  })
  const list = listView.element
  const renderList = (): void => listView.render()

  const detail = document.createElement('div')
  detail.className = 'memory-detail'

  const detailHead = document.createElement('div')
  detailHead.className = 'memory-detail-head'
  const status = document.createElement('div')
  status.className = 'memory-status'
  const askBtn = document.createElement('button')
  askBtn.className = 'memory-action'
  askBtn.title = i18nT('common.sendToAiChat')
  askBtn.innerHTML = icon('chat')
  const regenerateBtn = document.createElement('button')
  regenerateBtn.className = 'memory-action'
  regenerateBtn.title = i18nT('memory.regenerateSummaryFromTranscript')
  regenerateBtn.textContent = i18nT('memory.regenerate')
  const archiveBtn = document.createElement('button')
  archiveBtn.className = 'memory-action'
  archiveBtn.title = i18nT('memory.archiveEntry')
  archiveBtn.textContent = i18nT('memory.archive')
  const pinBtn = document.createElement('button')
  pinBtn.className = 'memory-action'
  pinBtn.title = i18nT('memory.keepThisMemoryPrioritized')
  pinBtn.textContent = i18nT('memory.pin')
  const verifyBtn = document.createElement('button')
  verifyBtn.className = 'memory-action'
  verifyBtn.title = i18nT('memory.markContentAsManuallyReviewed')
  verifyBtn.textContent = i18nT('memory.verify')
  const supersedeBtn = document.createElement('button')
  supersedeBtn.className = 'memory-action'
  supersedeBtn.title = i18nT('memory.markAsObsoleteOrReplaced')
  supersedeBtn.textContent = i18nT('memory.obsolete')
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'memory-action danger'
  deleteBtn.title = i18nT('memory.deleteEntry')
  deleteBtn.innerHTML = icon('trash')
  detailHead.append(status, askBtn, regenerateBtn, pinBtn, verifyBtn, supersedeBtn, archiveBtn, deleteBtn)

  const form = document.createElement('div')
  form.className = 'memory-form'

  const kind = document.createElement('select')
  kind.className = 'memory-input'
  KIND_OPTIONS.filter((value): value is MemoryKind => value !== 'all').forEach(value => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = KIND_LABEL[value]
    kind.appendChild(option)
  })

  const source = document.createElement('input')
  source.className = 'memory-input'
  source.placeholder = i18nT('memory.sourceManualCodexClaude')

  const titleInput = document.createElement('input')
  titleInput.className = 'memory-input'
  titleInput.placeholder = i18nT('common.title')

  const tags = document.createElement('input')
  tags.className = 'memory-input'
  tags.placeholder = i18nT('memory.tagsPlaceholder')

  const files = document.createElement('input')
  files.className = 'memory-input'
  files.placeholder = i18nT('memory.filesSrcATsSrcBTs')

  const summary = document.createElement('textarea')
  summary.className = 'memory-textarea summary'
  summary.placeholder = i18nT('memory.shortReusableSummary')

  const details = document.createElement('textarea')
  details.className = 'memory-textarea'
  details.placeholder = i18nT('memory.detailsContextWhyNextStep')

  const saveBtn = document.createElement('button')
  saveBtn.className = 'memory-primary'
  saveBtn.textContent = i18nT('common.save')

  form.append(kind, source, titleInput, tags, files, summary, details, saveBtn)
  detail.append(detailHead, form)
  const summaryJobsView = createMemorySummaryJobsView({
    currentProject,
    setStatus: (message, entry) => setStatus(message, entry),
    onRegenerated: async updated => {
      if (updated) selectedId = updated.id
      await reload()
    },
  })

  // The callbacks are wrapped rather than passed directly: reload and
  // revealMemoryEntry are declared further down.
  const sourcesView = createMemorySourcesView({
    repo,
    currentProject,
    setStatus: message => setStatus(message),
    onImported: async lastAffectedId => {
      await reload()
      revealMemoryEntry(lastAffectedId)
    },
  })

  cs.list.append(controls, summaryJobsView.element, sourcesView.element, list)
  root.append(cs.element, cs.resizer, detail)

  let entries: MemoryEntry[] = []
  let selectedId: string | null = null

  // The Rust importer answers in snake_case; the rest of the panel speaks the
  // candidate shape.
  const toCandidate = (item: ImportedMemory): ImportedMemoryCandidate => ({
    title: item.title,
    summary: item.summary,
    details: item.details,
    source: item.source,
    externalId: item.external_id,
    createdAt: item.created_at,
    files: item.files,
    tags: item.tags,
  })

  interface ImportedMemory {
    title: string
    summary: string
    details: string
    source: string
    external_id: string
    created_at: string
    files: string[]
    tags: string[]
  }

  const selected = (): MemoryEntry | undefined => entries.find(entry => entry.id === selectedId)
  const visibleRows = (): MemoryEntry[] => filterMemoryEntries(entries, {
    query: search.value,
    kind: kindFilter.value as MemoryKind | 'all',
    source: sourceFilter.value,
    includeArchived: archivedCheckbox.checked,
  })

  const selectedRows = (): MemoryEntry[] => entries.filter(entry => selectedIds.has(entry.id))
  const targetProjectEntries = async (): Promise<MemoryEntry[]> => {
    const rows = await repo.list(currentProject)
    return rows.filter(entry => entry.projectPath === currentProject)
  }

  const setStatus = (message?: string, entry?: MemoryEntry): void => {
    if (message) {
      status.textContent = message
      return
    }
    status.textContent = entry
      ? `${KIND_LABEL[entry.kind]} · ${sourceLabel(entry.source)} · ${timeLabel(entry.updatedAt)}`
      : currentProject
        ? i18nT('memory.projectLabel', { project: currentProject })
        : i18nT('memory.globalMemory')
  }

  const syncBulkButtons = (): void => {
    const count = selectedIds.size
    clearSelectionBtn.disabled = count === 0
    archiveSelectedBtn.disabled = count === 0
    deleteSelectedBtn.disabled = count === 0
    mergeSelectedBtn.disabled = count < 2
    archiveSelectedBtn.textContent = count > 0 ? i18nT('memory.archiveCount', { count }) : i18nT('memory.archive')
    deleteSelectedBtn.textContent = count > 0 ? i18nT('memory.deleteCount', { count }) : i18nT('common.delete2')
    mergeSelectedBtn.textContent = count > 1 ? i18nT('memory.mergeCount', { count }) : i18nT('memory.merge')
  }

  const refreshSourceFilter = (): void => {
    const sources = ['all', ...new Set(entries.map(entry => entry.source).filter(Boolean).sort())]
    const previous = sourceFilter.value || 'all'
    sourceFilter.innerHTML = ''
    sources.forEach(value => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value === 'all' ? i18nT('memory.allSources') : value
      sourceFilter.appendChild(option)
    })
    sourceFilter.value = sources.includes(previous) ? previous : 'all'
  }

  const fillForm = (entry?: MemoryEntry): void => {
    kind.value = entry?.kind ?? 'decision'
    source.value = entry?.source ?? 'manual'
    titleInput.value = entry?.title ?? ''
    tags.value = entry?.tags.join(', ') ?? ''
    files.value = entry?.files.join(', ') ?? ''
    summary.value = entry?.summary ?? ''
    details.value = entry?.details ?? ''
    deleteBtn.disabled = !entry
    askBtn.disabled = !entry
    archiveBtn.disabled = !entry
    pinBtn.disabled = !entry
    verifyBtn.disabled = !entry
    supersedeBtn.disabled = !entry
    pinBtn.textContent = entry?.tags.includes(MEMORY_PINNED_TAG) ? i18nT('memory.unpin') : i18nT('memory.pin')
    verifyBtn.textContent = entry?.tags.includes(MEMORY_VERIFIED_TAG) ? i18nT('memory.verified') : i18nT('memory.verify')
    supersedeBtn.textContent = entry?.tags.includes(MEMORY_SUPERSEDED_TAG) ? i18nT('memory.restore') : i18nT('memory.obsolete')
    regenerateBtn.disabled = !canRegenerateSummary(entry)
    setStatus(undefined, entry)
  }

  const reload = async (): Promise<void> => {
    try {
      entries = await repo.list(currentProject)
    } catch {
      setStatus(i18nT('memory.couldNotReadMemoryPressReload'))
      return
    }
    entries = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    selectedIds.forEach(id => { if (!entries.some(entry => entry.id === id)) selectedIds.delete(id) })
    if (selectedId && !entries.some(entry => entry.id === selectedId)) selectedId = null
    if (!selectedId && entries[0]) selectedId = entries[0].id
    refreshSourceFilter()
    fillForm(selected())
    renderList()
    syncBulkButtons()
    await sourcesView.refreshPreview()
  }

  const revealMemoryEntry = (entryId: string | null): void => {
    if (!entryId) return
    const entry = entries.find(item => item.id === entryId)
    if (!entry) return
    search.value = ''
    kindFilter.value = 'all'
    sourceFilter.value = 'all'
    archivedCheckbox.checked = isArchivedMemory(entry)
    selectedId = entry.id
    fillForm(entry)
    renderList()
    requestAnimationFrame(() => list.querySelector<HTMLElement>('.memory-item.active')?.scrollIntoView({ block: 'nearest' }))
  }

  const { archiveEntries, deleteEntries, mergeSelected, toggleSelectedTag } = createMemoryEntryActions({
    repo,
    getEntries: () => entries,
    getSelectedId: () => selectedId,
    setSelectedId: id => { selectedId = id },
    selectedIds,
    reload: () => reload(),
    setStatus: (message, entry) => setStatus(message, entry),
  })

  addBtn.addEventListener('click', () => {
    selectedId = null
    fillForm()
    renderList()
    titleInput.focus()
  })
  refreshBtn.addEventListener('click', () => { void Promise.all([reload(), summaryJobsView.reload()]) })

  search.addEventListener('input', renderList)
  kindFilter.addEventListener('change', renderList)
  sourceFilter.addEventListener('change', renderList)
  archivedCheckbox.addEventListener('change', renderList)
  selectVisibleBtn.addEventListener('click', () => {
    visibleRows().forEach(entry => selectedIds.add(entry.id))
    renderList()
    syncBulkButtons()
  })
  clearSelectionBtn.addEventListener('click', () => {
    selectedIds.clear()
    renderList()
    syncBulkButtons()
  })
  archiveSelectedBtn.addEventListener('click', () => { void archiveEntries(selectedRows()) })
  mergeSelectedBtn.addEventListener('click', () => { void mergeSelected().catch(error => setStatus(String(error))) })
  deleteSelectedBtn.addEventListener('click', () => { void deleteEntries(selectedRows()).catch(error => setStatus(String(error))) })
  const importEntries = async (sourceName: 'claude' | 'codex'): Promise<void> => {
    if (!currentProject) {
      setStatus(i18nT('memory.openAProjectBeforeImportingMemory'))
      return
    }
    const command = sourceName === 'claude' ? 'memory_import_claude' : 'memory_import_codex'
    try {
      setStatus(i18nT('memory.importingFrom', { source: sourceName === 'claude' ? 'Claude' : 'Codex' }))
      const imported = await invoke<ImportedMemory[]>(command, { projectPath: currentProject, limit: 8 })
      if (!imported.length) {
        setStatus(i18nT('memory.noNewHistoryWasFoundToImport'))
        return
      }
      const existing = await targetProjectEntries()
      const { saved, merged, skipped } = await runCandidateImport(
        repo, currentProject, imported.map(toCandidate), existing,
        // Agent imports keep the memory's own timestamp instead of stamping now.
        undefined, candidate => candidate.createdAt,
      )
      await reload()
      setStatus(i18nT('memory.importResultExisting', { saved, merged, skipped }))
    } catch (error) {
      setStatus(i18nT('memory.importFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  importClaudeBtn.addEventListener('click', () => { void importEntries('claude') })
  importCodexBtn.addEventListener('click', () => { void importEntries('codex') })

  saveBtn.addEventListener('click', () => { void (async () => {
    const payload: NewMemoryEntry = {
      kind: kind.value as MemoryKind,
      source: source.value.trim() || 'manual',
      title: titleInput.value.trim(),
      summary: summary.value.trim(),
      details: details.value.trim(),
      tags: splitList(tags.value),
      files: splitList(files.value),
    }
    if (!payload.title && !payload.summary && !payload.details) return
    try {
      saveBtn.disabled = true
      const entry = selectedId
        ? await repo.update(currentProject, selectedId, payload)
        : await repo.create(currentProject, payload)
      if (!entry) throw new Error('La entrada ya no existe.')
      selectedId = entry.id
      await reload()
      setStatus(i18nT('memory.memorySaved'), entry)
    } catch (error) {
      setStatus(i18nT('memory.saveFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      saveBtn.disabled = false
    }
  })() })

  archiveBtn.addEventListener('click', () => { void archiveEntries(selected() ? [selected()!] : []).catch(error => setStatus(String(error))) })
  pinBtn.addEventListener('click', () => { void toggleSelectedTag(MEMORY_PINNED_TAG).catch(error => setStatus(String(error))) })
  verifyBtn.addEventListener('click', () => { void toggleSelectedTag(MEMORY_VERIFIED_TAG).catch(error => setStatus(String(error))) })
  supersedeBtn.addEventListener('click', () => { void toggleSelectedTag(MEMORY_SUPERSEDED_TAG).catch(error => setStatus(String(error))) })
  deleteBtn.addEventListener('click', () => { void deleteEntries(selected() ? [selected()!] : []).catch(error => setStatus(String(error))) })
  regenerateBtn.addEventListener('click', () => { void (async () => {
    const entry = selected()
    if (!entry || !entry.externalId.includes(':session-summary:')) return
    try {
      regenerateBtn.disabled = true
      setStatus(i18nT('memory.regeneratingSummaryFromTranscript'))
      const updated = await invoke<MemoryEntry | null>('memory_regenerate_summary', {
        projectPath: entry.projectPath,
        externalId: entry.externalId,
      })
      if (!updated) {
        setStatus(i18nT('memory.theSummaryCouldNotBeRegeneratedOrThere'))
        return
      }
      selectedId = updated.id
      await reload()
      setStatus(i18nT('memory.summaryRegenerated'), updated)
    } catch (error) {
      setStatus(i18nT('memory.regenerateFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      regenerateBtn.disabled = !canRegenerateSummary(selected())
    }
  })() })

  askBtn.addEventListener('click', () => {
    const entry = selected()
    if (!entry) return
    askAi(
      `Contexto — memoria reutilizable del proyecto${currentProject ? ` (${currentProject})` : ''}:\n\n` +
      `Tipo: ${KIND_LABEL[entry.kind]}\n` +
      `Origen: ${entry.source}\n` +
      `Título: ${entry.title}\n` +
      `Tags: ${entry.tags.join(', ')}\n` +
      `Archivos: ${entry.files.join(', ')}\n\n` +
      `${entry.summary}\n\n${entry.details}\n`
    )
  })

  syncBulkButtons()
  void reload()
  return { element: root }
}
