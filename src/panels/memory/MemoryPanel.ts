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
  decision: 'Decisión',
  fact: 'Hecho',
  task: 'Tarea',
  note: 'Nota',
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

const sourceLabel = (value: string): string => value || 'manual'
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
  title.textContent = 'Memoria'
  const project = document.createElement('span')
  project.className = 'memory-project'
  project.textContent = currentProject || 'Global'
  const addBtn = document.createElement('button')
  addBtn.className = 'memory-action'
  addBtn.title = 'Nueva entrada'
  addBtn.innerHTML = icon('plus')
  const importClaudeBtn = document.createElement('button')
  importClaudeBtn.className = 'memory-action'
  importClaudeBtn.title = 'Importar desde Claude'
  importClaudeBtn.textContent = 'Claude'
  const importCodexBtn = document.createElement('button')
  importCodexBtn.className = 'memory-action'
  importCodexBtn.title = 'Importar desde Codex'
  importCodexBtn.textContent = 'Codex'
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'memory-action'
  refreshBtn.title = 'Recargar memoria'
  refreshBtn.textContent = 'Recargar'
  header.append(title, project, refreshBtn, importClaudeBtn, importCodexBtn, addBtn)

  const controls = document.createElement('div')
  controls.className = 'memory-controls'

  const search = document.createElement('input')
  search.className = 'memory-search'
  search.placeholder = 'Buscar por texto, tag, archivo…'

  const kindFilter = document.createElement('select')
  kindFilter.className = 'memory-filter'
  KIND_OPTIONS.forEach(value => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value === 'all' ? 'Todos los tipos' : KIND_LABEL[value]
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
  selectVisibleBtn.textContent = 'Seleccionar visibles'
  const clearSelectionBtn = document.createElement('button')
  clearSelectionBtn.className = 'memory-action'
  clearSelectionBtn.textContent = 'Limpiar selección'
  const archiveSelectedBtn = document.createElement('button')
  archiveSelectedBtn.className = 'memory-action'
  archiveSelectedBtn.textContent = 'Archivar'
  const mergeSelectedBtn = document.createElement('button')
  mergeSelectedBtn.className = 'memory-action'
  mergeSelectedBtn.textContent = 'Fusionar'
  const deleteSelectedBtn = document.createElement('button')
  deleteSelectedBtn.className = 'memory-action danger'
  deleteSelectedBtn.textContent = 'Borrar'
  controls.append(search, kindFilter, sourceFilter, archivedToggle, selectVisibleBtn, clearSelectionBtn, archiveSelectedBtn, mergeSelectedBtn, deleteSelectedBtn)

  const summaryJobsPanel = document.createElement('details')
  summaryJobsPanel.className = 'memory-summary-jobs'
  const summaryJobsTitle = document.createElement('summary')
  summaryJobsTitle.textContent = 'Resúmenes de sesión'
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
  sourcesHint.textContent = 'Importa resúmenes, notas y snapshots desde carpetas externas.'
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
  sourceLabelInput.placeholder = 'Etiqueta'
  const sourcePathInput = document.createElement('input')
  sourcePathInput.className = 'memory-input'
  sourcePathInput.placeholder = '/ruta/a/resumenes-o-notas'
  const sourceFormActions = document.createElement('div')
  sourceFormActions.className = 'memory-source-form-actions'
  const pickSourceBtn = document.createElement('button')
  pickSourceBtn.className = 'memory-action'
  pickSourceBtn.textContent = 'Seleccionar carpeta'
  const addSourceBtn = document.createElement('button')
  addSourceBtn.className = 'memory-action'
  addSourceBtn.textContent = 'Registrar fuente'
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
  selectVisiblePreviewBtn.textContent = 'Seleccionar visibles'
  const clearVisiblePreviewBtn = document.createElement('button')
  clearVisiblePreviewBtn.className = 'memory-action'
  clearVisiblePreviewBtn.textContent = 'Limpiar visibles'
  const sourceProjectFilter = document.createElement('select')
  sourceProjectFilter.className = 'memory-filter memory-source-project-filter'
  const sourcePreview = document.createElement('div')
  sourcePreview.className = 'memory-source-preview'
  sourcePreview.textContent = 'Sin vista previa de importación.'
  const importSelectedSourceBtn = document.createElement('button')
  importSelectedSourceBtn.className = 'memory-action'
  importSelectedSourceBtn.textContent = 'Importar seleccionados'
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
  askBtn.title = 'Enviar al chat de IA'
  askBtn.innerHTML = icon('chat')
  const regenerateBtn = document.createElement('button')
  regenerateBtn.className = 'memory-action'
  regenerateBtn.title = 'Regenerar resumen desde transcript'
  regenerateBtn.textContent = 'Regenerar'
  const archiveBtn = document.createElement('button')
  archiveBtn.className = 'memory-action'
  archiveBtn.title = 'Archivar entrada'
  archiveBtn.textContent = 'Archivar'
  const pinBtn = document.createElement('button')
  pinBtn.className = 'memory-action'
  pinBtn.title = 'Mantener esta memoria como prioritaria'
  pinBtn.textContent = 'Fijar'
  const verifyBtn = document.createElement('button')
  verifyBtn.className = 'memory-action'
  verifyBtn.title = 'Marcar contenido revisado manualmente'
  verifyBtn.textContent = 'Verificar'
  const supersedeBtn = document.createElement('button')
  supersedeBtn.className = 'memory-action'
  supersedeBtn.title = 'Marcar como obsoleta o reemplazada'
  supersedeBtn.textContent = 'Obsoleta'
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'memory-action danger'
  deleteBtn.title = 'Eliminar entrada'
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
  source.placeholder = 'Origen (manual, codex, claude...)'

  const titleInput = document.createElement('input')
  titleInput.className = 'memory-input'
  titleInput.placeholder = 'Título'

  const tags = document.createElement('input')
  tags.className = 'memory-input'
  tags.placeholder = 'tags: bento, db, sqlite'

  const files = document.createElement('input')
  files.className = 'memory-input'
  files.placeholder = 'archivos: src/a.ts, src/b.ts'

  const summary = document.createElement('textarea')
  summary.className = 'memory-textarea summary'
  summary.placeholder = 'Resumen corto y reusable'

  const details = document.createElement('textarea')
  details.className = 'memory-textarea'
  details.placeholder = 'Detalle, contexto, por qué, siguiente paso...'

  const saveBtn = document.createElement('button')
  saveBtn.className = 'memory-primary'
  saveBtn.textContent = 'Guardar'

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
    if (previewSourceId === '__draft__') return sourceLabelInput.value.trim() || basename(sourcePathInput.value.trim()) || 'Selección actual'
    return currentSource()?.label ?? 'Selección actual'
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
        ? `Proyecto: ${currentProject}`
        : 'Memoria global'
  }

  const renderSummaryJobs = (): void => {
    const pending = summaryJobs.filter(job => job.status === 'pending' || job.status === 'processing')
    const failed = summaryJobs.filter(job => job.status === 'failed')
    const completed = summaryJobs.filter(job => job.status === 'completed' || job.status === 'skipped')
    summaryJobsTitle.textContent = [
      'Resúmenes de sesión',
      pending.length ? `${pending.length} pendientes` : '',
      failed.length ? `${failed.length} fallidos` : '',
      completed.length ? `${completed.length} procesados` : '',
    ].filter(Boolean).join(' · ')
    summaryJobsList.innerHTML = ''
    const actionable = [...pending, ...failed]
    if (!actionable.length) {
      summaryJobsList.textContent = summaryJobs.length
        ? 'No hay resúmenes pendientes ni fallidos.'
        : 'Todavía no hay cierres de sesión registrados.'
      return
    }
    actionable.forEach(job => {
      const row = document.createElement('div')
      row.className = `memory-summary-job ${job.status}`
      const text = document.createElement('div')
      const projectLabel = projectName(job.projectPath) || 'Global'
      text.textContent = `${job.agent} · ${projectLabel} · ${job.status}${job.error ? ` · ${job.error}` : ''}`
      row.appendChild(text)
      if (job.status === 'failed' || job.status === 'pending') {
        const retry = document.createElement('button')
        retry.className = 'memory-action'
        retry.textContent = 'Reintentar'
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
      ? `Importar seleccionados (${selectedCount})`
      : 'Importar seleccionados'
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
      ? 'Sección contraída. Ábrela para registrar, escanear o importar.'
      : 'Importa resúmenes, notas y snapshots desde carpetas externas.'
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
        ? `Todos los proyectos (${previewCandidates.length})`
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
    archiveSelectedBtn.textContent = count > 0 ? `Archivar (${count})` : 'Archivar'
    deleteSelectedBtn.textContent = count > 0 ? `Borrar (${count})` : 'Borrar'
    mergeSelectedBtn.textContent = count > 1 ? `Fusionar (${count})` : 'Fusionar'
  }

  const refreshSourceFilter = (): void => {
    const sources = ['all', ...new Set(entries.map(entry => entry.source).filter(Boolean).sort())]
    const previous = sourceFilter.value || 'all'
    sourceFilter.innerHTML = ''
    sources.forEach(value => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value === 'all' ? 'Todos los orígenes' : value
      sourceFilter.appendChild(option)
    })
    sourceFilter.value = sources.includes(previous) ? previous : 'all'
  }

  const renderSourcePreview = (): void => {
    const label = previewLabel()
    refreshSourceProjectFilter()
    const candidates = visiblePreviewCandidates()
    if (!previewCandidates.length) {
      sourcePreview.textContent = previewSourceId ? `${label}: sin candidatos importables.` : 'Sin vista previa de importación.'
      syncSourceActions()
      return
    }
    if (!candidates.length) {
      sourcePreview.textContent = 'No hay candidatos para el proyecto filtrado.'
      syncSourceActions()
      return
    }
    sourcePreview.innerHTML = ''
    const heading = document.createElement('div')
    heading.className = 'memory-source-preview-title'
    heading.textContent = `Vista previa: ${label} (${candidates.length}/${previewCandidates.length})`
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
      title.textContent = candidate.title || '(sin título)'
      const summary = document.createElement('div')
      summary.className = 'memory-source-preview-summary'
      summary.textContent = candidate.summary || '(sin resumen)'
      const file = document.createElement('div')
      file.className = 'memory-source-preview-file'
      file.textContent = candidateProject(candidate)
      text.append(title, summary, file)
      if (state?.duplicateExternal || state?.duplicateSemantic) {
        const badge = document.createElement('div')
        badge.className = `memory-source-preview-badge ${state.duplicateExternal ? 'existing' : 'merge'}`
        badge.textContent = state.duplicateExternal
          ? 'Ya importado'
          : `Se fusionará${state.duplicateTitle ? ` con ${state.duplicateTitle}` : ''}`
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
      empty.textContent = 'No hay fuentes registradas todavía.'
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
      scanBtn.textContent = 'Escanear'
      scanBtn.addEventListener('click', () => { void scanSource(item) })
      const importBtn = document.createElement('button')
      importBtn.className = 'memory-action'
      importBtn.textContent = 'Importar'
      importBtn.addEventListener('click', () => { void importSource(item) })
      const removeBtn = document.createElement('button')
      removeBtn.className = 'memory-action danger'
      removeBtn.textContent = 'Borrar'
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
      setStatus(`Escaneando ${item.label}…`)
      setSourceActivity(`Escaneando ${item.label}…`)
      previewCandidates = await invoke<ImportedMemoryCandidate[]>('memory_source_scan', {
        projectPath: currentProject,
        id: item.id,
        limit: SOURCE_PREVIEW_LIMIT,
      })
      selectedSourceProject = 'all'
      previewSourceId = item.id
      await refreshPreviewCandidateState()
      renderSourcePreview()
      setSourceActivity(`${previewCandidates.length} candidatos listos en ${item.label}.`, 100)
      setStatus(`${previewCandidates.length} candidatos detectados en ${item.label}.`)
    } catch (error) {
      setSourceActivity(undefined)
      setStatus(`No se pudo escanear la fuente: ${error instanceof Error ? error.message : String(error)}`)
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
      setStatus('Escaneando carpeta seleccionada…')
      setSourceActivity('Escaneando carpeta seleccionada…')
      previewCandidates = await invoke<ImportedMemoryCandidate[]>('memory_source_scan_path', {
        path,
        label: sourceLabelInput.value.trim() || undefined,
        limit: SOURCE_PREVIEW_LIMIT,
      })
      selectedSourceProject = 'all'
      previewSourceId = '__draft__'
      await refreshPreviewCandidateState()
      renderSourcePreview()
      setSourceActivity(`${previewCandidates.length} candidatos listos en la carpeta seleccionada.`, 100)
      setStatus(`${previewCandidates.length} candidatos detectados en la carpeta seleccionada.`)
    } catch (error) {
      previewSourceId = '__draft__'
      previewCandidates = []
      previewCandidateState.clear()
      renderSourcePreview()
      setSourceActivity(undefined)
      setStatus(`No se pudo previsualizar la carpeta: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const importSource = async (item: MemorySource): Promise<void> => {
    try {
      setStatus(`Preparando importación desde ${item.label}…`)
      setSourceActivity(`Escaneando ${item.label} antes de importar…`)
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
        setSourceActivity(`Importando ${item.label} (${index + 1}/${candidates.length})…`, ((index + 1) / Math.max(candidates.length, 1)) * 100)
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
      setSourceActivity(`${saved} importadas, ${merged} fusionadas, ${skipped} omitidas desde ${item.label}.`, 100)
      setStatus(`${saved} importadas, ${merged} fusionadas, ${skipped} omitidas desde ${item.label}.`)
    } catch (error) {
      setSourceActivity(undefined)
      setStatus(`No se pudo importar la fuente: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const removeSource = async (item: MemorySource): Promise<void> => {
    const confirmed = await askConfirm(
      `¿Eliminar la fuente “${item.label}”?`,
      { title: 'Eliminar fuente', kind: 'warning', okLabel: 'Eliminar', cancelLabel: 'Cancelar' },
    )
    if (!confirmed) return
    try {
      await invoke<boolean>('memory_source_remove', { projectPath: currentProject, id: item.id })
      if (previewSourceId === item.id) {
        previewSourceId = null
        previewCandidates = []
      }
      await reloadSources()
      setStatus(`Fuente ${item.label} eliminada.`)
    } catch (error) {
      setStatus(`No se pudo eliminar la fuente: ${error instanceof Error ? error.message : String(error)}`)
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
    pinBtn.textContent = entry?.tags.includes(MEMORY_PINNED_TAG) ? 'Desfijar' : 'Fijar'
    verifyBtn.textContent = entry?.tags.includes(MEMORY_VERIFIED_TAG) ? 'Verificada' : 'Verificar'
    supersedeBtn.textContent = entry?.tags.includes(MEMORY_SUPERSEDED_TAG) ? 'Restaurar' : 'Obsoleta'
    regenerateBtn.disabled = !canRegenerateSummary(entry)
    setStatus(undefined, entry)
  }

  const renderList = (): void => {
    list.innerHTML = ''
    const rows = visibleRows()
    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'memory-empty'
      empty.textContent = 'No hay memoria guardada para este filtro.'
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
      entryTitle.textContent = entry.title || '(sin título)'
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
        ? entry.summary || entry.details || '(sin resumen)'
        : `${entry.projectPath || 'Global'} · ${entry.summary || entry.details || '(sin resumen)'}`
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
      setStatus('No se pudo leer la memoria. Pulsa Recargar.')
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
      setStatus(`Regenerando resumen ${job.agent}…`)
      const updated = await invoke<MemoryEntry | null>('memory_regenerate_summary', {
        projectPath: job.projectPath,
        externalId: `${job.agent}:session-summary:${job.sessionId}`,
      })
      if (updated) selectedId = updated.id
      await reload()
      await reloadSummaryJobs()
      setStatus(updated ? 'Resumen regenerado.' : 'El resumidor no devolvió memoria reutilizable.', updated ?? undefined)
    } catch (error) {
      await reloadSummaryJobs()
      setStatus(`No se pudo regenerar: ${error instanceof Error ? error.message : String(error)}`)
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
    setStatus(rows.length === 1 ? 'Memoria archivada.' : `${rows.length} memorias archivadas.`)
  }

  const deleteEntries = async (rows: MemoryEntry[]): Promise<void> => {
    if (!rows.length) return
    const confirmed = await askConfirm(
      rows.length === 1
        ? `¿Eliminar permanentemente la memoria “${rows[0].title || 'Sin título'}”?`
        : `¿Eliminar permanentemente ${rows.length} memorias?`,
      { title: 'Eliminar memoria', kind: 'warning', okLabel: 'Eliminar', cancelLabel: 'Cancelar' },
    )
    if (!confirmed) return
    for (const entry of rows) {
      await repo.remove(entry.projectPath, entry.id)
      selectedIds.delete(entry.id)
      if (selectedId === entry.id) selectedId = null
    }
    await reload()
    setStatus(rows.length === 1 ? 'Memoria eliminada.' : `${rows.length} memorias eliminadas.`)
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
    setStatus(`${rows.length} memorias fusionadas.`, saved)
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
      setStatus('La fuente necesita etiqueta y ruta.')
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
      setStatus(`Fuente ${label} registrada.`)
    } catch (error) {
      setStatus(`No se pudo registrar la fuente: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      syncSourceForm()
    }
  })() })

  archiveSelectedBtn.addEventListener('click', () => { void archiveEntries(selectedRows()) })
  mergeSelectedBtn.addEventListener('click', () => { void mergeSelected().catch(error => setStatus(String(error))) })
  deleteSelectedBtn.addEventListener('click', () => { void deleteEntries(selectedRows()).catch(error => setStatus(String(error))) })
  importSelectedSourceBtn.addEventListener('click', () => { void (async () => {
    if (!previewSourceId) {
      setStatus('No hay una fuente escaneada para importar.')
      return
    }
    const sourceLabel = importSourceLabel()
    const candidates = selectedPreviewCandidates()
    if (!candidates.length) {
      setStatus('Selecciona al menos un archivo antes de importar.')
      return
    }
    try {
      importSelectedSourceBtn.disabled = true
      setStatus(`Importando ${candidates.length} seleccionadas desde ${sourceLabel}…`)
      const existing = await targetProjectEntries()
      let saved = 0
      let merged = 0
      let skipped = 0
      let lastAffectedId: string | null = null
      for (const [index, candidate] of candidates.entries()) {
        setSourceActivity(`Importando selección (${index + 1}/${candidates.length})…`, ((index + 1) / Math.max(candidates.length, 1)) * 100)
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
      setSourceActivity(`${saved} importadas, ${merged} fusionadas, ${skipped} ya existentes desde ${sourceLabel}.`, 100)
      setStatus(`${saved} importadas, ${merged} fusionadas, ${skipped} ya existentes desde ${sourceLabel}.`)
    } catch (error) {
      setSourceActivity(undefined)
      setStatus(`No se pudo importar la selección: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      syncSourceActions()
    }
  })() })

  const importEntries = async (sourceName: 'claude' | 'codex'): Promise<void> => {
    if (!currentProject) {
      setStatus('Abre un proyecto antes de importar memoria.')
      return
    }
    const command = sourceName === 'claude' ? 'memory_import_claude' : 'memory_import_codex'
    try {
      setStatus(`Importando desde ${sourceName === 'claude' ? 'Claude' : 'Codex'}…`)
      const imported = await invoke<ImportedMemory[]>(command, { projectPath: currentProject, limit: 8 })
      if (!imported.length) {
        setStatus('No se encontró historial nuevo para importar.')
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
      setStatus(`${saved} importadas, ${merged} fusionadas, ${skipped} ya existentes.`)
    } catch (error) {
      setStatus(`No se pudo importar: ${error instanceof Error ? error.message : String(error)}`)
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
      setStatus('Memoria guardada.', entry)
    } catch (error) {
      setStatus(`No se pudo guardar: ${error instanceof Error ? error.message : String(error)}`)
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
      setStatus('Regenerando resumen desde el transcript…')
      const updated = await invoke<MemoryEntry | null>('memory_regenerate_summary', {
        projectPath: entry.projectPath,
        externalId: entry.externalId,
      })
      if (!updated) {
        setStatus('No se pudo regenerar el resumen o no hay transcript asociado.')
        return
      }
      selectedId = updated.id
      await reload()
      setStatus('Resumen regenerado.', updated)
    } catch (error) {
      setStatus(`No se pudo regenerar: ${error instanceof Error ? error.message : String(error)}`)
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
