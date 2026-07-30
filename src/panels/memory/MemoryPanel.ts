import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm, open as pickFolder } from '@tauri-apps/plugin-dialog'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'
import type { MemoryEntry, MemoryKind, NewMemoryEntry } from '../../core/memory/MemoryEntry'
import {
  MEMORY_ARCHIVED_TAG,
  MEMORY_PINNED_TAG,
  MEMORY_SUPERSEDED_TAG,
  MEMORY_VERIFIED_TAG,
  archiveMemoryTags,
  findSemanticallyDuplicate,
  isArchivedMemory,
  mergeMemoryEntries,
  normalizeNewMemoryEntry,
  toggleMemoryTag,
  uniqMemoryValues,
} from '../../core/memory/normalize'
import { matchesMemoryQuery } from '../../core/memory/memorySearch'
import type { MemoryRepository } from '../../ports/MemoryRepository'

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: i18nT('memory.decision'),
  fact: i18nT('memory.fact'),
  task: i18nT('memory.task'),
  note: i18nT('common.note'),
}

const KIND_OPTIONS: Array<MemoryKind | 'all'> = ['all', 'decision', 'fact', 'task', 'note']
const SOURCE_PREVIEW_LIMIT = 200

const splitList = (value: string): string[] => uniqMemoryValues(value.split(','))
const basename = (value: string): string => value.split(/[\\/]/).filter(Boolean).pop() ?? ''
const projectName = (value: string): string => basename(value) || value
const detailProject = (value: string): string | null => {
  const match = value.match(/^Proyecto indexado:\s+(.+)$/m)
  return match?.[1]?.trim() ?? null
}
const lexisProjectFolder = (value: string): string | null => {
  const normalized = value.replace(/\\/g, '/')
  const marker = '/.lexis/projects/'
  const start = normalized.indexOf(marker)
  if (start < 0) return null
  const rest = normalized.slice(start + marker.length)
  const folder = rest.split('/')[0]?.trim()
  return folder || null
}

const timeLabel = (iso: string): string => {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

const sourceLabel = (value: string): string => value || i18nT('memory.manual')
const canRegenerateSummary = (entry?: MemoryEntry): boolean => Boolean(entry?.externalId && entry.externalId.includes(':session-summary:'))

interface MemorySource {
  id: string
  projectPath: string
  kind: 'filesystem'
  label: string
  path: string
  createdAt: string
  updatedAt: string
}

interface ImportedMemoryCandidate {
  title: string
  summary: string
  details: string
  source: string
  externalId: string
  createdAt: string
  files: string[]
  tags: string[]
}

interface PreviewCandidateState {
  duplicateExternal: boolean
  duplicateSemantic: boolean
  duplicateTitle?: string
}

interface MemorySummaryJob {
  id: string
  projectPath: string
  agent: 'claude' | 'codex'
  sessionId: string
  transcriptExternalId: string
  transcriptHash: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  error: string
  attempts: number
  metadataJson: string
  createdAt: string
  updatedAt: string
}

export function createMemoryPanel(repo: MemoryRepository, projectPath?: string): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'memory-panel'

  const currentProject = projectPath?.trim() ?? ''
  const sourcesCollapsedKey = `bento.memory.sources.collapsed:${currentProject || '__global__'}`
  let sourcesCollapsed = localStorage.getItem(sourcesCollapsedKey) !== '0'

  const header = document.createElement('div')
  header.className = 'memory-header'
  const title = document.createElement('span')
  title.className = 'memory-title'
  title.textContent = i18nT('memory.memory')
  const project = document.createElement('span')
  project.className = 'memory-project'
  project.textContent = currentProject || i18nT('common.global')
  const addBtn = document.createElement('button')
  addBtn.className = 'memory-action'
  addBtn.title = i18nT('memory.newEntry')
  addBtn.innerHTML = icon('plus')
  const importClaudeBtn = document.createElement('button')
  importClaudeBtn.className = 'memory-action'
  importClaudeBtn.title = i18nT('memory.importFromClaude')
  importClaudeBtn.textContent = i18nT('memory.claude')
  const importCodexBtn = document.createElement('button')
  importCodexBtn.className = 'memory-action'
  importCodexBtn.title = i18nT('memory.importFromCodex')
  importCodexBtn.textContent = i18nT('memory.codex')
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'memory-action'
  refreshBtn.title = i18nT('memory.reloadMemory')
  refreshBtn.textContent = i18nT('common.reload')
  header.append(title, project, refreshBtn, importClaudeBtn, importCodexBtn, addBtn)

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

  const summaryJobsPanel = document.createElement('details')
  summaryJobsPanel.className = 'memory-summary-jobs'
  const summaryJobsTitle = document.createElement('summary')
  summaryJobsTitle.textContent = i18nT('memory.sessionSummaries')
  const summaryJobsList = document.createElement('div')
  summaryJobsList.className = 'memory-summary-jobs-list'
  summaryJobsPanel.append(summaryJobsTitle, summaryJobsList)

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

  const body = document.createElement('div')
  body.className = 'memory-body'

  const list = document.createElement('div')
  list.className = 'memory-list'

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
  body.append(list, detail)
  root.append(header, controls, summaryJobsPanel, sourcesPanel, body)

  let entries: MemoryEntry[] = []
  let summaryJobs: MemorySummaryJob[] = []
  let selectedId: string | null = null
  const selectedIds = new Set<string>()
  let sources: MemorySource[] = []
  let previewCandidates: ImportedMemoryCandidate[] = []
  let previewSourceId: string | null = null
  const previewCandidateState = new Map<string, PreviewCandidateState>()
  let selectedSourceProject = 'all'

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
  const currentSource = (): MemorySource | undefined => sources.find(source => source.id === previewSourceId)
  const importSourceLabel = (): string => currentSource()?.label ?? previewLabel()
  const previewLabel = (): string => {
    if (previewSourceId === '__draft__') return sourceLabelInput.value.trim() || basename(sourcePathInput.value.trim()) || i18nT('memory.currentSelection')
    return currentSource()?.label ?? i18nT('memory.currentSelection')
  }
  const candidateProject = (candidate: ImportedMemoryCandidate): string => {
    if (candidate.source.startsWith('source:') && candidate.tags.includes('lexis')) {
      const detailed = detailProject(candidate.details)
      if (detailed) return projectName(detailed)
      const absoluteProject = candidate.files.find(file => file.startsWith('/Users/') || file.startsWith('/private/') || file.startsWith('/var/'))
      if (absoluteProject && !absoluteProject.includes('/.lexis/projects/')) return projectName(absoluteProject)
      const lexisIndex = candidate.files.find(file => file.includes('/.lexis/projects/'))
      const folder = lexisIndex ? lexisProjectFolder(lexisIndex) : null
      if (folder) return folder
      const titled = candidate.title.replace(/^Lexis snapshot ·\s*/, '').trim()
      if (titled && titled !== candidate.title) return titled
      return 'Proyecto desconocido'
    }
    return projectName(candidate.files[0] || candidate.externalId)
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

  const visibleRows = (): MemoryEntry[] => {
    const kindValue = kindFilter.value as MemoryKind | 'all'
    const sourceValue = sourceFilter.value
    return entries.filter(entry => {
      if (!archivedCheckbox.checked && isArchivedMemory(entry)) return false
      if (kindValue !== 'all' && entry.kind !== kindValue) return false
      if (sourceValue !== 'all' && entry.source !== sourceValue) return false
      return matchesMemoryQuery(entry, search.value)
    })
  }

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

  const renderSummaryJobs = (): void => {
    const pending = summaryJobs.filter(job => job.status === 'pending' || job.status === 'processing')
    const failed = summaryJobs.filter(job => job.status === 'failed')
    const completed = summaryJobs.filter(job => job.status === 'completed' || job.status === 'skipped')
    summaryJobsTitle.textContent = i18nT('memory.summaryJobs', {
      pending: pending.length ? i18nT('memory.pendingCount', { count: pending.length }) : '',
      failed: failed.length ? i18nT('memory.failedCount', { count: failed.length }) : '',
      completed: completed.length ? i18nT('memory.processedCount', { count: completed.length }) : '',
    })
    summaryJobsList.innerHTML = ''
    const actionable = [...pending, ...failed]
    if (!actionable.length) {
      summaryJobsList.textContent = summaryJobs.length
        ? i18nT('memory.thereAreNoPendingOrFailedSummaries')
        : i18nT('memory.thereAreNoRecordedSessionClosuresYet')
      return
    }
    actionable.forEach(job => {
      const row = document.createElement('div')
      row.className = `memory-summary-job ${job.status}`
      const text = document.createElement('div')
      const projectLabel = projectName(job.projectPath) || i18nT('common.global')
      text.textContent = `${job.agent} · ${projectLabel} · ${job.status}${job.error ? ` · ${job.error}` : ''}`
      row.appendChild(text)
      if (job.status === 'failed' || job.status === 'pending') {
        const retry = document.createElement('button')
        retry.className = 'memory-action'
        retry.textContent = i18nT('memory.retry')
        retry.addEventListener('click', () => { void retrySummaryJob(job) })
        row.appendChild(retry)
      }
      summaryJobsList.appendChild(row)
    })
    if (failed.length) summaryJobsPanel.open = true
  }

  const reloadSummaryJobs = async (): Promise<void> => {
    try {
      summaryJobs = await invoke<MemorySummaryJob[]>('memory_summary_job_list', { projectPath: currentProject })
    } catch {
      summaryJobs = []
    }
    renderSummaryJobs()
  }

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

  const computePreviewCandidateState = (candidate: ImportedMemoryCandidate, existing: MemoryEntry[]): PreviewCandidateState => {
    const payload: NewMemoryEntry = {
      kind: 'note',
      title: candidate.title,
      summary: candidate.summary,
      details: candidate.details,
      source: candidate.source,
      externalId: candidate.externalId,
      files: candidate.files,
      tags: candidate.tags,
      createdAt: candidate.createdAt,
      updatedAt: candidate.createdAt,
    }
    const normalized = normalizeNewMemoryEntry(currentProject, payload)
    const duplicateExternal = existing.some(entry => entry.externalId === normalized.externalId)
    const duplicate = duplicateExternal ? existing.find(entry => entry.externalId === normalized.externalId) : findSemanticallyDuplicate(existing, normalized)
    return {
      duplicateExternal,
      duplicateSemantic: !duplicateExternal && Boolean(duplicate),
      duplicateTitle: duplicate?.title || undefined,
    }
  }

  const refreshPreviewCandidateState = async (): Promise<void> => {
    previewCandidateState.clear()
    if (!previewCandidates.length) return
    const existing = await targetProjectEntries()
    previewCandidates.forEach(candidate => previewCandidateState.set(candidate.externalId, computePreviewCandidateState(candidate, existing)))
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
      let saved = 0
      let merged = 0
      let skipped = 0
      let lastAffectedId: string | null = null
      for (const [index, candidate] of candidates.entries()) {
        setSourceActivity(i18nT('memory.importingProgress', { label: item.label, current: index + 1, total: candidates.length }), ((index + 1) / Math.max(candidates.length, 1)) * 100)
        const payload: NewMemoryEntry = {
          kind: 'note',
          title: candidate.title,
          summary: candidate.summary,
          details: candidate.details,
          source: candidate.source,
          externalId: candidate.externalId,
          files: candidate.files,
          tags: candidate.tags,
          createdAt: candidate.createdAt,
          updatedAt: new Date().toISOString(),
        }
        const normalized = normalizeNewMemoryEntry(currentProject, payload)
        const existingExternal = existing.find(entry => entry.externalId === normalized.externalId)
        if (existingExternal) {
          lastAffectedId = existingExternal.id
          skipped++
          continue
        }
        const duplicate = findSemanticallyDuplicate(existing, normalized)
        if (duplicate) {
          const updated = await repo.update(currentProject, duplicate.id, {
            tags: uniqMemoryValues([...duplicate.tags, ...normalized.tags]),
            files: uniqMemoryValues([...duplicate.files, ...normalized.files]),
            summary: duplicate.summary.length >= normalized.summary.length ? duplicate.summary : normalized.summary,
            details: duplicate.details.length >= normalized.details.length ? duplicate.details : normalized.details,
          })
          lastAffectedId = updated?.id ?? duplicate.id
          merged++
          continue
        }
        const created = await repo.create(currentProject, payload)
        existing.unshift(created)
        lastAffectedId = created.id
        saved++
      }
      await reload()
      revealMemoryEntry(lastAffectedId)
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

  const renderList = (): void => {
    list.innerHTML = ''
    const rows = visibleRows()
    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'memory-empty'
      empty.textContent = i18nT('memory.thereIsNoSavedMemoryForThisFilter')
      list.appendChild(empty)
      return
    }
    rows.forEach(entry => {
      const item = document.createElement('div')
      item.className = entry.id === selectedId ? 'memory-item active' : 'memory-item'
      const top = document.createElement('div')
      top.className = 'memory-item-top'
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selectedIds.has(entry.id)
      checkbox.addEventListener('click', event => event.stopPropagation())
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(entry.id)
        else selectedIds.delete(entry.id)
        syncBulkButtons()
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
        selectedId = entry.id
        fillForm(entry)
        renderList()
      })
      list.appendChild(item)
    })
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
    if (previewCandidates.length) {
      await refreshPreviewCandidateState()
      renderSourcePreview()
    }
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

  const retrySummaryJob = async (job: MemorySummaryJob): Promise<void> => {
    try {
      setStatus(i18nT('memory.regeneratingAgent', { agent: job.agent }))
      const updated = await invoke<MemoryEntry | null>('memory_regenerate_summary', {
        projectPath: job.projectPath,
        externalId: `${job.agent}:session-summary:${job.sessionId}`,
      })
      if (updated) selectedId = updated.id
      await reload()
      await reloadSummaryJobs()
      setStatus(updated ? i18nT('memory.summaryRegenerated') : i18nT('memory.theSummarizerReturnedNoReusableMemory'), updated ?? undefined)
    } catch (error) {
      await reloadSummaryJobs()
      setStatus(i18nT('memory.regenerateFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const toggleSelectedTag = async (tag: string): Promise<void> => {
    const entry = selected()
    if (!entry) return
    const updated = await repo.update(entry.projectPath, entry.id, { tags: toggleMemoryTag(entry, tag) })
    if (!updated) return
    selectedId = updated.id
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
      if (selectedId === entry.id) selectedId = null
    }
    await reload()
    setStatus(rows.length === 1 ? i18nT('memory.memoryDeleted') : i18nT('memory.deletedCount', { count: rows.length }))
  }

  const mergeSelected = async (): Promise<void> => {
    const rows = selectedRows()
    if (rows.length < 2) return
    const merged = mergeMemoryEntries(rows)
    const target = selected() && selectedIds.has(selectedId!) ? selected()! : rows[0]
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
    selectedId = target.id
    await reload()
    setStatus(i18nT('memory.mergedCount', { count: rows.length }), saved)
  }

  addBtn.addEventListener('click', () => {
    selectedId = null
    fillForm()
    renderList()
    titleInput.focus()
  })
  refreshBtn.addEventListener('click', () => { void Promise.all([reload(), reloadSummaryJobs()]) })

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

  archiveSelectedBtn.addEventListener('click', () => { void archiveEntries(selectedRows()) })
  mergeSelectedBtn.addEventListener('click', () => { void mergeSelected().catch(error => setStatus(String(error))) })
  deleteSelectedBtn.addEventListener('click', () => { void deleteEntries(selectedRows()).catch(error => setStatus(String(error))) })
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
      let saved = 0
      let merged = 0
      let skipped = 0
      let lastAffectedId: string | null = null
      for (const [index, candidate] of candidates.entries()) {
        setSourceActivity(i18nT('memory.importingSelectionProgress', { current: index + 1, total: candidates.length }), ((index + 1) / Math.max(candidates.length, 1)) * 100)
        const payload: NewMemoryEntry = {
          kind: 'note',
          title: candidate.title,
          summary: candidate.summary,
          details: candidate.details,
          source: candidate.source,
          externalId: candidate.externalId,
          files: candidate.files,
          tags: candidate.tags,
          createdAt: candidate.createdAt,
          updatedAt: new Date().toISOString(),
        }
        const normalized = normalizeNewMemoryEntry(currentProject, payload)
        const existingExternal = existing.find(entry => entry.externalId === normalized.externalId)
        if (existingExternal) {
          lastAffectedId = existingExternal.id
          skipped++
          continue
        }
        const duplicate = findSemanticallyDuplicate(existing, normalized)
        if (duplicate) {
          const updated = await repo.update(currentProject, duplicate.id, {
            tags: uniqMemoryValues([...duplicate.tags, ...normalized.tags]),
            files: uniqMemoryValues([...duplicate.files, ...normalized.files]),
            summary: duplicate.summary.length >= normalized.summary.length ? duplicate.summary : normalized.summary,
            details: duplicate.details.length >= normalized.details.length ? duplicate.details : normalized.details,
          })
          lastAffectedId = updated?.id ?? duplicate.id
          merged++
          continue
        }
        const created = await repo.create(currentProject, payload)
        existing.unshift(created)
        lastAffectedId = created.id
        saved++
      }
      await reload()
      revealMemoryEntry(lastAffectedId)
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
      let saved = 0
      let merged = 0
      let skipped = 0
      for (const item of imported) {
        const payload: NewMemoryEntry = {
          kind: 'note',
          title: item.title,
          summary: item.summary,
          details: item.details,
          source: item.source,
          externalId: item.external_id,
          files: item.files,
          tags: item.tags,
          createdAt: item.created_at,
          updatedAt: item.created_at,
        }
        const normalized = normalizeNewMemoryEntry(currentProject, payload)
        if (existing.some(entry => entry.externalId === normalized.externalId)) {
          skipped++
          continue
        }
        const duplicate = findSemanticallyDuplicate(existing, normalized)
        if (duplicate) {
          await repo.update(currentProject, duplicate.id, {
            tags: uniqMemoryValues([...duplicate.tags, ...normalized.tags]),
            files: uniqMemoryValues([...duplicate.files, ...normalized.files]),
            summary: duplicate.summary.length >= normalized.summary.length ? duplicate.summary : normalized.summary,
            details: duplicate.details.length >= normalized.details.length ? duplicate.details : normalized.details,
          })
          merged++
          continue
        }
        const created = await repo.create(currentProject, payload)
        existing.unshift(created)
        saved++
      }
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
  syncSourceActions()
  syncSourceForm()
  syncSourcesCollapsed()
  void reloadSources()
  void reload()
  void reloadSummaryJobs()
  return { element: root }
}
