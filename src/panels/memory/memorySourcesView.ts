import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/icons'
import { confirm as askConfirm, open as pickFolder } from '@tauri-apps/plugin-dialog'
import type { MemoryEntry } from '../../core/memory/MemoryEntry'
import { basename, projectName } from '../../core/memory/memoryFormat'
import { candidateProject, computePreviewCandidateState } from '../../core/memory/memoryCandidates'
import type {
  MemorySource, ImportedMemoryCandidate, PreviewCandidateState,
} from '../../core/memory/memorySource'
import type { MemoryRepository } from '../../ports/MemoryRepository'
import { runCandidateImport } from './memoryImportRunner'

const SOURCE_PREVIEW_LIMIT = 200

export interface MemorySourcesViewDeps {
  repo: MemoryRepository
  currentProject: string
  setStatus: (message?: string) => void
  /** Called after an import so the panel can reload and reveal the entry it touched. */
  onImported: (lastAffectedId: string | null) => Promise<void>
}

export interface MemorySourcesView {
  element: HTMLElement
  reload: () => Promise<void>
  /** Re-checks the previewed candidates against the stored entries. */
  refreshPreview: () => Promise<void>
}

/**
 * The "external sources" section: register folders, scan them for importable
 * memories, preview what would land (flagging duplicates) and import a selection.
 */
export function createMemorySourcesView(deps: MemorySourcesViewDeps): MemorySourcesView {
  const { repo, currentProject, setStatus, onImported } = deps

  let sources: MemorySource[] = []
  let previewCandidates: ImportedMemoryCandidate[] = []
  let previewSourceId: string | null = null
  const previewCandidateState = new Map<string, PreviewCandidateState>()
  let selectedSourceProject = 'all'

  const targetProjectEntries = async (): Promise<MemoryEntry[]> => {
    const rows = await repo.list(currentProject)
    return rows.filter(entry => entry.projectPath === currentProject)
  }

  const sourcesCollapsedKey = `bento.memory.sources.collapsed:${currentProject || '__global__'}`
  let sourcesCollapsed = localStorage.getItem(sourcesCollapsedKey) !== '0'

  const sourcesPanel = document.createElement('div')
  sourcesPanel.className = 'memory-sources'
  const sourcesHead = document.createElement('div')
  sourcesHead.className = 'memory-sources-head'
  const sourcesToggle = document.createElement('button')
  sourcesToggle.className = 'memory-sources-toggle'
  sourcesToggle.type = 'button'
  const sourcesTitle = document.createElement('span')
  sourcesTitle.className = 'memory-sources-title'
  const baseSourcesTitle = 'Fuentes externas'
  sourcesTitle.textContent = baseSourcesTitle
  const sourcesHint = document.createElement('span')
  sourcesHint.className = 'memory-sources-hint'
  sourcesHint.textContent = i18nT('memory.importSummariesNotesAndSnapshotsFromExternalFolders')
  const sourcesChevron = document.createElement('span')
  sourcesChevron.className = 'memory-sources-chevron'
  sourcesChevron.innerHTML = icon('chevron')
  const sourcesGrid = document.createElement('div')
  sourcesGrid.className = 'memory-sources-grid'
  const sourcesControl = document.createElement('div')
  sourcesControl.className = 'memory-sources-control'
  const sourceForm = document.createElement('div')
  sourceForm.className = 'memory-source-form'
  const sourceLabelInput = document.createElement('input')
  sourceLabelInput.className = 'memory-input'
  sourceLabelInput.placeholder = i18nT('memory.label')
  const sourcePathInput = document.createElement('input')
  sourcePathInput.className = 'memory-input'
  sourcePathInput.placeholder = i18nT('memory.pathToSummariesOrNotes')
  const sourceFormActions = document.createElement('div')
  sourceFormActions.className = 'memory-source-form-actions'
  const pickSourceBtn = document.createElement('button')
  pickSourceBtn.className = 'memory-action'
  pickSourceBtn.textContent = i18nT('memory.selectFolder')
  const addSourceBtn = document.createElement('button')
  addSourceBtn.className = 'memory-action'
  addSourceBtn.textContent = i18nT('memory.registerSource')
  const sourceList = document.createElement('div')
  sourceList.className = 'memory-source-list'
  const sourcePreviewPanel = document.createElement('div')
  sourcePreviewPanel.className = 'memory-source-preview-panel'
  const sourceActivity = document.createElement('div')
  sourceActivity.className = 'memory-source-activity hidden'
  const sourceActivityText = document.createElement('div')
  sourceActivityText.className = 'memory-source-activity-text'
  const sourceActivityBar = document.createElement('div')
  sourceActivityBar.className = 'memory-source-activity-bar'
  const sourceActivityBarFill = document.createElement('div')
  sourceActivityBarFill.className = 'memory-source-activity-bar-fill'
  sourceActivityBar.appendChild(sourceActivityBarFill)
  const sourcePreviewActions = document.createElement('div')
  sourcePreviewActions.className = 'memory-source-preview-actions'
  const selectVisiblePreviewBtn = document.createElement('button')
  selectVisiblePreviewBtn.className = 'memory-action'
  selectVisiblePreviewBtn.textContent = i18nT('memory.selectVisible')
  const clearVisiblePreviewBtn = document.createElement('button')
  clearVisiblePreviewBtn.className = 'memory-action'
  clearVisiblePreviewBtn.textContent = i18nT('memory.clearVisible')
  const sourceProjectFilter = document.createElement('select')
  sourceProjectFilter.className = 'memory-filter memory-source-project-filter'
  const sourcePreview = document.createElement('div')
  sourcePreview.className = 'memory-source-preview'
  sourcePreview.textContent = i18nT('memory.noImportPreview')
  const importSelectedSourceBtn = document.createElement('button')
  importSelectedSourceBtn.className = 'memory-action'
  importSelectedSourceBtn.textContent = i18nT('memory.importSelected')
  importSelectedSourceBtn.disabled = true
  sourcesToggle.append(sourcesChevron, sourcesTitle)
  sourcesHead.append(sourcesToggle, sourcesHint)
  sourceFormActions.append(pickSourceBtn, addSourceBtn)
  sourceForm.append(sourceLabelInput, sourcePathInput, sourceFormActions)
  sourcesControl.append(sourceForm, sourceList)
  sourceActivity.append(sourceActivityText, sourceActivityBar)
  sourcePreviewActions.append(selectVisiblePreviewBtn, clearVisiblePreviewBtn)
  sourcePreviewPanel.append(sourceActivity, sourcePreviewActions, sourceProjectFilter, sourcePreview, importSelectedSourceBtn)
  sourcesGrid.append(sourcesControl, sourcePreviewPanel)
  sourcesPanel.append(sourcesHead, sourcesGrid)

  const currentSource = (): MemorySource | undefined => sources.find(source => source.id === previewSourceId)
  const importSourceLabel = (): string => currentSource()?.label ?? previewLabel()
  const previewLabel = (): string => {
    if (previewSourceId === '__draft__') return sourceLabelInput.value.trim() || basename(sourcePathInput.value.trim()) || i18nT('memory.currentSelection')
    return currentSource()?.label ?? i18nT('memory.currentSelection')
  }
  const visiblePreviewCandidates = (): ImportedMemoryCandidate[] => previewCandidates.filter(candidate => {
    if (selectedSourceProject === 'all') return true
    return candidateProject(candidate) === selectedSourceProject
  })
  const previewCheckedIds = (): Set<string> => new Set(
    Array.from(sourcePreview.querySelectorAll<HTMLInputElement>('.memory-source-preview-checkbox:checked'))
      .map(input => input.value)
      .filter(Boolean),
  )
  const selectedPreviewCandidates = (): ImportedMemoryCandidate[] => {
    const checked = previewCheckedIds()
    return visiblePreviewCandidates().filter(candidate => checked.has(candidate.externalId))
  }
  const selectedPreviewCount = (): number => previewCheckedIds().size

  const syncSourceActions = (): void => {
    const selectedCount = selectedPreviewCount()
    importSelectedSourceBtn.disabled = selectedCount === 0
    importSelectedSourceBtn.textContent = selectedCount > 0
      ? i18nT('memory.importSelectedCount', { count: selectedCount })
      : i18nT('memory.importSelected')
    const visibleCount = visiblePreviewCandidates().length
    selectVisiblePreviewBtn.disabled = visibleCount === 0
    clearVisiblePreviewBtn.disabled = visibleCount === 0 || selectedCount === 0
  }

  const refreshPreviewCandidateState = async (): Promise<void> => {
    previewCandidateState.clear()
    if (!previewCandidates.length) return
    const existing = await targetProjectEntries()
    previewCandidates.forEach(candidate => previewCandidateState.set(candidate.externalId, computePreviewCandidateState(currentProject, candidate, existing)))
  }

  const syncSourceForm = (): void => {
    addSourceBtn.disabled = sourcePathInput.value.trim().length === 0
  }

  const syncSourcesTitle = (): void => {
    sourcesTitle.textContent = `${baseSourcesTitle} (${sources.length})`
  }

  const syncSourcesCollapsed = (): void => {
    sourcesPanel.classList.toggle('collapsed', sourcesCollapsed)
    sourcesChevron.classList.toggle('collapsed', sourcesCollapsed)
    sourcesHint.textContent = sourcesCollapsed
      ? i18nT('memory.sectionCollapsedOpenItToRegisterScanOr')
      : i18nT('memory.importSummariesNotesAndSnapshotsFromExternalFolders')
  }

  const setSourceActivity = (message?: string, progress?: number): void => {
    if (!message) {
      sourceActivity.classList.add('hidden')
      sourceActivityBar.classList.toggle('indeterminate', false)
      sourceActivityBarFill.style.width = '0%'
      sourceActivityText.textContent = ''
      return
    }
    sourceActivity.classList.remove('hidden')
    sourceActivityText.textContent = message
    if (progress === undefined) {
      sourceActivityBar.classList.add('indeterminate')
      sourceActivityBarFill.style.width = '100%'
      return
    }
    sourceActivityBar.classList.remove('indeterminate')
    sourceActivityBarFill.style.width = `${Math.max(0, Math.min(100, progress))}%`
  }

  const refreshSourceProjectFilter = (): void => {
    const counts = new Map<string, number>()
    previewCandidates.map(candidateProject).forEach(project => counts.set(project, (counts.get(project) ?? 0) + 1))
    const projects = ['all', ...[...counts.keys()].sort((a, b) => a.localeCompare(b))]
    if (!projects.includes(selectedSourceProject)) selectedSourceProject = 'all'
    sourceProjectFilter.innerHTML = ''
    projects.forEach(value => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value === 'all'
        ? i18nT('memory.allProjectsCount', { count: previewCandidates.length })
        : `${projectName(value)} (${counts.get(value) ?? 0})`
      sourceProjectFilter.appendChild(option)
    })
    sourceProjectFilter.value = selectedSourceProject
    sourceProjectFilter.disabled = projects.length <= 1
  }

  const renderSourcePreview = (): void => {
    const label = previewLabel()
    refreshSourceProjectFilter()
    const candidates = visiblePreviewCandidates()
    if (!previewCandidates.length) {
      sourcePreview.textContent = previewSourceId ? i18nT('memory.noImportableCandidates', { label }) : i18nT('memory.noImportPreview')
      syncSourceActions()
      return
    }
    if (!candidates.length) {
      sourcePreview.textContent = i18nT('memory.thereAreNoCandidatesForTheFilteredProject')
      syncSourceActions()
      return
    }
    sourcePreview.innerHTML = ''
    const heading = document.createElement('div')
    heading.className = 'memory-source-preview-title'
    heading.textContent = i18nT('memory.previewHeading', { label, visible: candidates.length, total: previewCandidates.length })
    sourcePreview.appendChild(heading)
    candidates.forEach(candidate => {
      const state = previewCandidateState.get(candidate.externalId)
      const row = document.createElement('div')
      row.className = `memory-source-preview-item${state?.duplicateExternal || state?.duplicateSemantic ? ' duplicate' : ''}`
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = 'memory-source-preview-checkbox'
      checkbox.value = candidate.externalId
      checkbox.checked = false
      checkbox.addEventListener('click', event => event.stopPropagation())
      checkbox.addEventListener('change', syncSourceActions)
      const text = document.createElement('div')
      text.className = 'memory-source-preview-copy'
      const title = document.createElement('div')
      title.className = 'memory-source-preview-name'
      title.textContent = candidate.title || i18nT('memory.untitled')
      const summary = document.createElement('div')
      summary.className = 'memory-source-preview-summary'
      summary.textContent = candidate.summary || i18nT('memory.noSummary')
      const file = document.createElement('div')
      file.className = 'memory-source-preview-file'
      file.textContent = candidateProject(candidate)
      text.append(title, summary, file)
      if (state?.duplicateExternal || state?.duplicateSemantic) {
        const badge = document.createElement('div')
        badge.className = `memory-source-preview-badge ${state.duplicateExternal ? 'existing' : 'merge'}`
        badge.textContent = state.duplicateExternal
          ? i18nT('memory.alreadyImported')
          : state.duplicateTitle ? i18nT('memory.willMergeWith', { title: state.duplicateTitle }) : i18nT('memory.willMerge')
        text.appendChild(badge)
      }
      row.append(checkbox, text)
      sourcePreview.appendChild(row)
    })
    syncSourceActions()
  }

  const renderSources = (): void => {
    sourceList.innerHTML = ''
    syncSourceForm()
    syncSourcesTitle()
    if (!sources.length) {
      const empty = document.createElement('div')
      empty.className = 'memory-source-empty'
      empty.textContent = i18nT('memory.thereAreNoRegisteredSourcesYet')
      sourceList.appendChild(empty)
      renderSourcePreview()
      return
    }
    sources.forEach(item => {
      const row = document.createElement('div')
      row.className = 'memory-source-item'
      const meta = document.createElement('div')
      meta.className = 'memory-source-item-meta'
      const text = document.createElement('div')
      text.className = 'memory-source-item-text'
      text.textContent = item.label
      const path = document.createElement('div')
      path.className = 'memory-source-item-path'
      path.textContent = item.path
      meta.append(text, path)
      const actions = document.createElement('div')
      actions.className = 'memory-source-item-actions'
      const scanBtn = document.createElement('button')
      scanBtn.className = 'memory-action'
      scanBtn.textContent = i18nT('memory.scan')
      scanBtn.addEventListener('click', () => { void scanSource(item) })
      const importBtn = document.createElement('button')
      importBtn.className = 'memory-action'
      importBtn.textContent = i18nT('common.import')
      importBtn.addEventListener('click', () => { void importSource(item) })
      const removeBtn = document.createElement('button')
      removeBtn.className = 'memory-action danger'
      removeBtn.textContent = i18nT('common.delete2')
      removeBtn.addEventListener('click', () => { void removeSource(item) })
      actions.append(scanBtn, importBtn, removeBtn)
      row.append(meta, actions)
      row.addEventListener('click', event => {
        if (event.target instanceof HTMLButtonElement) return
        void scanSource(item)
      })
      sourceList.appendChild(row)
    })
    renderSourcePreview()
  }

  const reloadSources = async (): Promise<void> => {
    try {
      sources = await invoke<MemorySource[]>('memory_source_list', { projectPath: currentProject })
    } catch {
      sources = []
    }
    if (previewSourceId && !sources.some(source => source.id === previewSourceId)) {
      previewSourceId = null
      previewCandidates = []
      previewCandidateState.clear()
    }
    renderSources()
    if (!previewSourceId && sources.length === 1) {
      void scanSource(sources[0])
    }
  }

  const scanSource = async (item: MemorySource): Promise<void> => {
    try {
      setStatus(i18nT('memory.scanning', { label: item.label }))
      setSourceActivity(i18nT('memory.scanning', { label: item.label }))
      previewCandidates = await invoke<ImportedMemoryCandidate[]>('memory_source_scan', {
        projectPath: currentProject,
        id: item.id,
        limit: SOURCE_PREVIEW_LIMIT,
      })
      selectedSourceProject = 'all'
      previewSourceId = item.id
      await refreshPreviewCandidateState()
      renderSourcePreview()
      setSourceActivity(i18nT('memory.candidatesReady', { count: previewCandidates.length, label: item.label }), 100)
      setStatus(i18nT('memory.candidatesDetected', { count: previewCandidates.length, label: item.label }))
    } catch (error) {
      setSourceActivity(undefined)
      setStatus(i18nT('memory.scanSourceFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const previewDraftSource = async (): Promise<void> => {
    const path = sourcePathInput.value.trim()
    if (!path) {
      previewSourceId = null
      previewCandidates = []
      renderSourcePreview()
      return
    }
    try {
      setStatus(i18nT('memory.scanningSelectedFolder'))
      setSourceActivity(i18nT('memory.scanningSelectedFolder'))
      previewCandidates = await invoke<ImportedMemoryCandidate[]>('memory_source_scan_path', {
        path,
        label: sourceLabelInput.value.trim() || undefined,
        limit: SOURCE_PREVIEW_LIMIT,
      })
      selectedSourceProject = 'all'
      previewSourceId = '__draft__'
      await refreshPreviewCandidateState()
      renderSourcePreview()
      setSourceActivity(i18nT('memory.candidatesReady', { count: previewCandidates.length, label: i18nT('memory.selectedFolder') }), 100)
      setStatus(i18nT('memory.candidatesDetected', { count: previewCandidates.length, label: i18nT('memory.selectedFolder') }))
    } catch (error) {
      previewSourceId = '__draft__'
      previewCandidates = []
      previewCandidateState.clear()
      renderSourcePreview()
      setSourceActivity(undefined)
      setStatus(i18nT('memory.previewFolderFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const importSource = async (item: MemorySource): Promise<void> => {
    try {
      setStatus(i18nT('memory.preparingImport', { label: item.label }))
      setSourceActivity(i18nT('memory.scanningBeforeImport', { label: item.label }))
      const candidates = await invoke<ImportedMemoryCandidate[]>('memory_source_scan', {
        projectPath: currentProject,
        id: item.id,
        limit: 50,
      })
      const existing = await targetProjectEntries()
      const { saved, merged, skipped, lastAffectedId } = await runCandidateImport(
        repo, currentProject, candidates, existing,
        (current, total) => setSourceActivity(
          i18nT('memory.importingProgress', { label: item.label, current, total }),
          (current / Math.max(total, 1)) * 100,
        ),
      )
      await onImported(lastAffectedId)
      await reloadSources()
      const result = i18nT('memory.importResultSkipped', { saved, merged, skipped, label: item.label })
      setSourceActivity(result, 100)
      setStatus(result)
    } catch (error) {
      setSourceActivity(undefined)
      setStatus(i18nT('memory.importSourceFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const removeSource = async (item: MemorySource): Promise<void> => {
    const confirmed = await askConfirm(
      i18nT('memory.deleteSourceQuestion', { label: item.label }),
      { title: i18nT('memory.deleteSource'), kind: 'warning', okLabel: i18nT('common.delete'), cancelLabel: i18nT('common.cancel') },
    )
    if (!confirmed) return
    try {
      await invoke<boolean>('memory_source_remove', { projectPath: currentProject, id: item.id })
      if (previewSourceId === item.id) {
        previewSourceId = null
        previewCandidates = []
      }
      await reloadSources()
      setStatus(i18nT('memory.sourceDeleted', { label: item.label }))
    } catch (error) {
      setStatus(i18nT('memory.deleteSourceFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  sourcesToggle.addEventListener('click', () => {
    sourcesCollapsed = !sourcesCollapsed
    localStorage.setItem(sourcesCollapsedKey, sourcesCollapsed ? '1' : '0')
    syncSourcesCollapsed()
  })
  sourceLabelInput.addEventListener('input', syncSourceForm)
  sourceProjectFilter.addEventListener('change', () => {
    selectedSourceProject = sourceProjectFilter.value
    renderSourcePreview()
  })
  selectVisiblePreviewBtn.addEventListener('click', () => {
    sourcePreview.querySelectorAll<HTMLInputElement>('.memory-source-preview-checkbox').forEach(input => {
      input.checked = true
    })
    syncSourceActions()
  })
  clearVisiblePreviewBtn.addEventListener('click', () => {
    sourcePreview.querySelectorAll<HTMLInputElement>('.memory-source-preview-checkbox').forEach(input => {
      input.checked = false
    })
    syncSourceActions()
  })
  sourcePathInput.addEventListener('input', () => {
    if (!sourceLabelInput.value.trim()) sourceLabelInput.value = basename(sourcePathInput.value.trim())
    syncSourceForm()
  })
  pickSourceBtn.addEventListener('click', () => { void (async () => {
    const picked = await pickFolder({
      directory: true,
      defaultPath: sourcePathInput.value.trim() || currentProject || undefined,
    }).catch(() => null)
    if (typeof picked !== 'string') return
    sourcePathInput.value = picked
    if (!sourceLabelInput.value.trim()) sourceLabelInput.value = basename(picked)
    syncSourceForm()
    void previewDraftSource()
  })() })
  addSourceBtn.addEventListener('click', () => { void (async () => {
    const path = sourcePathInput.value.trim()
    const label = sourceLabelInput.value.trim() || basename(path)
    sourceLabelInput.value = label
    if (!label || !path) {
      setStatus(i18nT('memory.theSourceNeedsALabelAndPath'))
      return
    }
    try {
      addSourceBtn.disabled = true
      await invoke<MemorySource>('memory_source_create', {
        source: {
          id: crypto.randomUUID(),
          projectPath: currentProject,
          kind: 'filesystem',
          label,
          path,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })
      sourceLabelInput.value = ''
      sourcePathInput.value = ''
      await reloadSources()
      setStatus(i18nT('memory.sourceRegistered', { label }))
    } catch (error) {
      setStatus(i18nT('memory.registerSourceFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      syncSourceForm()
    }
  })() })

  importSelectedSourceBtn.addEventListener('click', () => { void (async () => {
    if (!previewSourceId) {
      setStatus(i18nT('memory.thereIsNoScannedSourceToImport'))
      return
    }
    const sourceLabel = importSourceLabel()
    const candidates = selectedPreviewCandidates()
    if (!candidates.length) {
      setStatus(i18nT('memory.selectAtLeastOneFileBeforeImporting'))
      return
    }
    try {
      importSelectedSourceBtn.disabled = true
      setStatus(i18nT('memory.importingSelected', { count: candidates.length, label: sourceLabel }))
      const existing = await targetProjectEntries()
      const { saved, merged, skipped, lastAffectedId } = await runCandidateImport(
        repo, currentProject, candidates, existing,
        (current, total) => setSourceActivity(
          i18nT('memory.importingSelectionProgress', { current, total }),
          (current / Math.max(total, 1)) * 100,
        ),
      )
      await onImported(lastAffectedId)
      await refreshPreviewCandidateState()
      renderSourcePreview()
      const result = i18nT('memory.importResultExistingFrom', { saved, merged, skipped, label: sourceLabel })
      setSourceActivity(result, 100)
      setStatus(result)
    } catch (error) {
      setSourceActivity(undefined)
      setStatus(i18nT('memory.importSelectionFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      syncSourceActions()
    }
  })() })

  const refreshPreview = async (): Promise<void> => {
    if (!previewCandidates.length) return
    await refreshPreviewCandidateState()
    renderSourcePreview()
  }

  syncSourceActions()
  syncSourceForm()
  syncSourcesCollapsed()
  void reloadSources()

  return { element: sourcesPanel, reload: reloadSources, refreshPreview }
}
