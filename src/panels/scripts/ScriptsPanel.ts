import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { scriptCommand } from '../../core/scripts/scriptCommand'
import { createTerminalPanel, type TerminalPanelHandle } from '../terminal/TerminalPanel'
import { icon } from '../../ui/icons'

const DIRS_KEY = 'bento.scripts.dirs'

interface ScriptFile { name: string; path: string; dir: string }

export interface ScriptsPanelHandle {
  element: HTMLElement
  fit: () => void
  dispose: () => void
}

const loadDirs = (): string[] => {
  try { return JSON.parse(localStorage.getItem(DIRS_KEY) ?? '[]') } catch { return [] }
}
const saveDirs = (dirs: string[]): void => {
  try { localStorage.setItem(DIRS_KEY, JSON.stringify(dirs)) } catch { /* storage lleno */ }
}

export function createScriptsPanel(projectPath = ''): ScriptsPanelHandle {
  const root = document.createElement('div')
  root.className = 'scripts-panel'

  // Seed with the session's project folder the first time, so it isn't empty.
  let dirs = loadDirs()
  if (!dirs.length && projectPath) { dirs = [projectPath]; saveDirs(dirs) }
  let files: ScriptFile[] = []
  let filter = '' // selected folder, '' = all

  // ---- header ----
  const header = document.createElement('div')
  header.className = 'scripts-header'
  const title = document.createElement('span')
  title.className = 'scripts-title'
  title.textContent = 'Scripts'

  const termToggle = document.createElement('button')
  termToggle.className = 'scripts-action'
  termToggle.title = 'Mostrar/ocultar terminal'
  termToggle.innerHTML = icon('terminal')

  const addBtn = document.createElement('button')
  addBtn.className = 'scripts-action'
  addBtn.title = 'Añadir carpeta a escanear'
  addBtn.innerHTML = `${icon('plus')}<span>Carpeta</span>`

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'scripts-action'
  refreshBtn.title = 'Volver a escanear'
  refreshBtn.innerHTML = icon('refresh')

  header.append(title, termToggle, addBtn, refreshBtn)

  // ---- folder dropdown (the routes the scripts come from) ----
  const filterRow = document.createElement('div')
  filterRow.className = 'scripts-filter-row'
  const filterSelect = document.createElement('select')
  filterSelect.className = 'scripts-filter'
  const removeBtn = document.createElement('button')
  removeBtn.className = 'scripts-dir-del'
  removeBtn.title = 'Quitar la carpeta seleccionada'
  removeBtn.textContent = '×'
  filterRow.append(filterSelect, removeBtn)

  // ---- body: scripts list + embedded terminal ----
  const body = document.createElement('div')
  body.className = 'scripts-body'
  const listEl = document.createElement('div')
  listEl.className = 'scripts-list'
  const divider = document.createElement('div')
  divider.className = 'scripts-divider hidden'
  const termWrap = document.createElement('div')
  termWrap.className = 'scripts-term hidden'
  termWrap.style.height = '240px'
  body.append(listEl, divider, termWrap)

  root.append(header, filterRow, body)

  // ---- embedded terminal (created on first use) ----
  let term: TerminalPanelHandle | undefined
  const hideTerm = (): void => {
    termWrap.classList.add('hidden')
    divider.classList.add('hidden')
  }
  // `exit` in the embedded terminal: hide and tear it down; the next run respawns.
  const onTermExit = (): void => {
    hideTerm()
    if (term) { term.dispose(); term.element.remove(); term = undefined }
  }
  const ensureTerm = (): TerminalPanelHandle => {
    if (!term) {
      term = createTerminalPanel('', projectPath, () => requestAnimationFrame(onTermExit))
      termWrap.appendChild(term.element)
    }
    return term
  }
  const isTermOpen = (): boolean => !termWrap.classList.contains('hidden')
  const showTerm = (): void => {
    ensureTerm()
    termWrap.classList.remove('hidden')
    divider.classList.remove('hidden')
    requestAnimationFrame(() => term!.fit())
  }

  const run = (path: string): void => {
    showTerm()
    ensureTerm().sendInput(scriptCommand(path))
  }

  // Drag the divider to resize the terminal height.
  divider.addEventListener('mousedown', e => {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => {
      const rect = body.getBoundingClientRect()
      const h = Math.max(80, Math.min(rect.height - 80, rect.bottom - ev.clientY))
      termWrap.style.height = `${h}px`
      term?.fit()
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  const renderFilter = (): void => {
    filterSelect.innerHTML = ''
    filterSelect.add(new Option('Todas las carpetas', ''))
    dirs.forEach(d => filterSelect.add(new Option(d, d)))
    filter = dirs.includes(filter) ? filter : ''
    filterSelect.value = filter
    removeBtn.classList.toggle('hidden', !filter)
  }

  const renderList = (): void => {
    listEl.innerHTML = ''
    if (!dirs.length) {
      const hint = document.createElement('div')
      hint.className = 'scripts-hint'
      hint.textContent = 'Añade una carpeta para listar tus scripts.'
      listEl.appendChild(hint)
      return
    }
    const shown = filter ? files.filter(f => f.dir === filter) : files
    if (!shown.length) {
      const empty = document.createElement('div')
      empty.className = 'scripts-hint'
      empty.textContent = 'Sin scripts en estas carpetas.'
      listEl.appendChild(empty)
      return
    }
    shown.forEach(f => {
      const row = document.createElement('button')
      row.className = 'scripts-item'
      row.title = `Ejecutar: ${scriptCommand(f.path)}`
      row.innerHTML = `${icon('play')}<span class="scripts-item-name">${f.name}</span><span class="scripts-item-dir">${f.dir}</span>`
      row.addEventListener('click', () => run(f.path))
      listEl.appendChild(row)
    })
  }

  const refresh = async (): Promise<void> => {
    files = dirs.length ? await invoke<ScriptFile[]>('list_scripts', { dirs }).catch(() => [] as ScriptFile[]) : []
    renderFilter()
    renderList()
  }

  addBtn.addEventListener('click', async () => {
    const picked = await open({ directory: true, defaultPath: projectPath || undefined }).catch(() => null)
    if (typeof picked !== 'string') return
    dirs = [...new Set([...dirs, picked])]
    saveDirs(dirs)
    refresh()
  })
  refreshBtn.addEventListener('click', refresh)
  termToggle.addEventListener('click', () => (isTermOpen() ? hideTerm() : showTerm()))
  filterSelect.addEventListener('change', () => { filter = filterSelect.value; removeBtn.classList.toggle('hidden', !filter); renderList() })
  removeBtn.addEventListener('click', () => {
    dirs = dirs.filter(d => d !== filter)
    saveDirs(dirs)
    filter = ''
    refresh()
  })

  refresh()

  return {
    element: root,
    fit: () => term?.fit(),
    dispose: () => term?.dispose(),
  }
}
