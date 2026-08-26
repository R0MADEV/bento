import { icon } from '../../ui/helpers/icons'
import { t as i18nT } from '../../i18n'

// El título base, que el panel completa con el número de fuentes.
export const BASE_SOURCES_TITLE = 'Fuentes externas'

// La estructura del bloque de fuentes de memoria: el desplegable, el
// formulario para añadir una, la lista, y el panel de vista previa con su
// barra de progreso. Solo crea elementos y los engancha.

export interface MemorySourcesDom {
  addSourceBtn: HTMLButtonElement
  clearVisiblePreviewBtn: HTMLButtonElement
  importSelectedSourceBtn: HTMLButtonElement
  pickSourceBtn: HTMLButtonElement
  selectVisiblePreviewBtn: HTMLButtonElement
  sourceActivity: HTMLElement
  sourceActivityBar: HTMLElement
  sourceActivityBarFill: HTMLElement
  sourceActivityText: HTMLElement
  sourceForm: HTMLElement
  sourceFormActions: HTMLElement
  sourceLabelInput: HTMLInputElement
  sourceList: HTMLElement
  sourcePathInput: HTMLInputElement
  sourcePreview: HTMLElement
  sourcePreviewActions: HTMLElement
  sourcePreviewPanel: HTMLElement
  sourceProjectFilter: HTMLSelectElement
  sourcesChevron: HTMLSpanElement
  sourcesControl: HTMLElement
  sourcesGrid: HTMLElement
  sourcesHead: HTMLElement
  sourcesHint: HTMLSpanElement
  sourcesPanel: HTMLElement
  sourcesTitle: HTMLSpanElement
  sourcesToggle: HTMLButtonElement
}

export function buildMemorySourcesDom(): MemorySourcesDom {
  const sourcesPanel = document.createElement('div')
  sourcesPanel.className = 'memory-sources'
  const sourcesHead = document.createElement('div')
  sourcesHead.className = 'memory-sources-head'
  const sourcesToggle = document.createElement('button')
  sourcesToggle.className = 'memory-sources-toggle'
  sourcesToggle.type = 'button'
  const sourcesTitle = document.createElement('span')
  sourcesTitle.className = 'memory-sources-title'
  const baseSourcesTitle = BASE_SOURCES_TITLE
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

  return { addSourceBtn, clearVisiblePreviewBtn, importSelectedSourceBtn, pickSourceBtn, selectVisiblePreviewBtn, sourceActivity, sourceActivityBar, sourceActivityBarFill, sourceActivityText, sourceForm, sourceFormActions, sourceLabelInput, sourceList, sourcePathInput, sourcePreview, sourcePreviewActions, sourcePreviewPanel, sourceProjectFilter, sourcesChevron, sourcesControl, sourcesGrid, sourcesHead, sourcesHint, sourcesPanel, sourcesTitle, sourcesToggle }
}
