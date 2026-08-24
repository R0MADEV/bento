import { t as i18nT } from '../../i18n'
import { candidateProject } from '../../core/memory/memoryCandidates'
import type { ImportedMemoryCandidate, PreviewCandidateState } from '../../core/memory/memorySource'

// La lista de candidatos a importar: qué se ve, qué está marcado y por qué un
// candidato aparece como ya importado o como pendiente de actualizar.

export interface MemorySourcesPreviewDeps {
  sourcePreview: HTMLElement
  previewLabel: () => string
  previewCandidates: () => ImportedMemoryCandidate[]
  visiblePreviewCandidates: () => ImportedMemoryCandidate[]
  previewSourceId: () => string | null
  candidateState: Map<string, PreviewCandidateState>
  refreshSourceProjectFilter: () => void
  syncSourceActions: () => void
}

export function buildMemorySourcesPreview(deps: MemorySourcesPreviewDeps): () => void {
  const { sourcePreview, candidateState, syncSourceActions } = deps
  const renderSourcePreview = (): void => {
    const label = deps.previewLabel()
    deps.refreshSourceProjectFilter()
    const candidates = deps.visiblePreviewCandidates()
    if (!deps.previewCandidates().length) {
      sourcePreview.textContent = deps.previewSourceId() ? i18nT('memory.noImportableCandidates', { label }) : i18nT('memory.noImportPreview')
      deps.syncSourceActions()
      return
    }
    if (!candidates.length) {
      sourcePreview.textContent = i18nT('memory.thereAreNoCandidatesForTheFilteredProject')
      deps.syncSourceActions()
      return
    }
    sourcePreview.innerHTML = ''
    const heading = document.createElement('div')
    heading.className = 'memory-source-preview-title'
    heading.textContent = i18nT('memory.previewHeading', { label, visible: candidates.length, total: deps.previewCandidates().length })
    sourcePreview.appendChild(heading)
    candidates.forEach(candidate => {
      const state = candidateState.get(candidate.externalId)
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
    deps.syncSourceActions()
  }

  return renderSourcePreview
}
