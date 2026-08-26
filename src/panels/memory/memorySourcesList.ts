import { t as i18nT } from '../../i18n'
import type { MemorySource } from '../../core/memory/memorySource'

// La lista de fuentes registradas: cada fila con su ruta y sus tres acciones
// (escanear, importar, quitar). Las acciones las pone quien la monta.

export interface MemorySourcesListDeps {
  sourceList: HTMLElement
  sources: () => MemorySource[]
  syncSourceForm: () => void
  syncSourcesTitle: () => void
  renderSourcePreview: () => void
  scanSource: (item: MemorySource) => void
  importSource: (item: MemorySource) => void
  removeSource: (item: MemorySource) => void
}

export function buildMemorySourcesList(deps: MemorySourcesListDeps): () => void {
  const { sourceList } = deps
  const renderSources = (): void => {
    sourceList.innerHTML = ''
    deps.syncSourceForm()
    deps.syncSourcesTitle()
    if (!deps.sources().length) {
      const empty = document.createElement('div')
      empty.className = 'memory-source-empty'
      empty.textContent = i18nT('memory.thereAreNoRegisteredSourcesYet')
      sourceList.appendChild(empty)
      deps.renderSourcePreview()
      return
    }
    deps.sources().forEach(item => {
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
      scanBtn.addEventListener('click', () => { deps.scanSource(item) })
      const importBtn = document.createElement('button')
      importBtn.className = 'memory-action'
      importBtn.textContent = i18nT('common.import')
      importBtn.addEventListener('click', () => { deps.importSource(item) })
      const removeBtn = document.createElement('button')
      removeBtn.className = 'memory-action danger'
      removeBtn.textContent = i18nT('common.delete2')
      removeBtn.addEventListener('click', () => { deps.removeSource(item) })
      actions.append(scanBtn, importBtn, removeBtn)
      row.append(meta, actions)
      row.addEventListener('click', event => {
        if (event.target instanceof HTMLButtonElement) return
        deps.scanSource(item)
      })
      sourceList.appendChild(row)
    })
    deps.renderSourcePreview()
  }

  return renderSources
}
