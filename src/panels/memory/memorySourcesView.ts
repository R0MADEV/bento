import { t as i18nT } from '../../i18n'
import { BASE_SOURCES_TITLE, buildMemorySourcesDom } from './memorySourcesDom'
import { buildMemorySourcesList } from './memorySourcesList'
import { buildMemorySourcesPreview } from './memorySourcesPreview'
import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm, open as pickFolder } from '@tauri-apps/plugin-dialog'
import type { MemoryEntry } from '../../core/memory/MemoryEntry'
import { basename, projectName } from '../../core/memory/memoryFormat'
import { candidateProject, computePreviewCandidateState } from '../../core/memory/memoryCandidates'
import type {
  MemorySource, ImportedMemoryCandidate, PreviewCandidateState,
} from '../../core/memory/memorySource'
import type { MemoryRepository } from '../../ports/MemoryRepository'
import { runCandidateImport } from '../../core/memory/importRunner'

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
  const {
    addSourceBtn,
    clearVisiblePreviewBtn,
    importSelectedSourceBtn,
    pickSourceBtn,
    selectVisiblePreviewBtn,
    sourceActivity,
    sourceActivityBarFill,
    sourceLabelInput,
    sourceList,
    sourcePathInput,
    sourcePreview,
    sourceProjectFilter,
    sourcesHint,
    sourcesPanel,
    sourcesTitle,
    sourcesToggle,
    sourcesChevron,
    sourceActivityText,
    sourceActivityBar,
  } = buildMemorySourcesDom()

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
    sourcesTitle.textContent = `${BASE_SOURCES_TITLE} (${sources.length})`
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
  const renderSourcePreview = buildMemorySourcesPreview({
    sourcePreview,
    previewLabel,
    previewCandidates: () => previewCandidates,
    visiblePreviewCandidates,
    previewSourceId: () => previewSourceId,
    candidateState: previewCandidateState,
    refreshSourceProjectFilter,
    syncSourceActions,
  })
  const renderSources = buildMemorySourcesList({
    sourceList,
    sources: () => sources,
    syncSourceForm,
    syncSourcesTitle,
    renderSourcePreview,
    scanSource: item => { void scanSource(item) },
    importSource: item => { void importSource(item) },
    removeSource: item => { void removeSource(item) },
  })

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
