import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { scriptCommand } from '../../core/scripts/scriptCommand'
import { createTerminalPanel, type TerminalPanelHandle } from '../terminal/TerminalPanel'
import { icon } from '../../ui/icons'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'

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

  // ---- collapsible sidebar (controls + scripts list) ----
  const cs = createCollapsibleSidebar({
    storageKey: 'bento.scripts.sidebar',
    title: i18nT('common.scripts'),
    defaultWidth: 260,
    minWidth: 180,
    minRemaining: 360,
    container: root,
  })
  // Fixed folder filter on top, scrolling scripts list below.
  Object.assign(cs.list.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column' })

  const termToggle = document.createElement('button')
  termToggle.className = 'scripts-action'
  termToggle.title = i18nT('scripts.showHideTerminal')
  termToggle.innerHTML = icon('terminal')

  const addBtn = document.createElement('button')
  addBtn.className = 'scripts-action'
  addBtn.title = i18nT('scripts.addFolderToScan')
  addBtn.innerHTML = icon('plus')

  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'scripts-action'
  refreshBtn.title = i18nT('scripts.scanAgain')
  refreshBtn.innerHTML = icon('refresh')

  cs.actions.append(termToggle, addBtn, refreshBtn)

  // ---- folder dropdown (the routes the scripts come from) ----
  const filterRow = document.createElement('div')
  filterRow.className = 'scripts-filter-row'
  const filterSelect = document.createElement('select')
  filterSelect.className = 'scripts-filter'
  const removeBtn = document.createElement('button')
  removeBtn.className = 'scripts-dir-del'
  removeBtn.title = i18nT('scripts.removeSelectedFolder')
  removeBtn.textContent = '×'
  filterRow.append(filterSelect, removeBtn)

  const listEl = document.createElement('div')
  listEl.className = 'scripts-list'
  cs.list.append(filterRow, listEl)

  // ---- detail: embedded terminal fills the right; shown when a script runs ----
  const detail = document.createElement('div')
  detail.className = 'scripts-detail'
  const termWrap = document.createElement('div')
  termWrap.className = 'scripts-term hidden'
  const emptyHint = document.createElement('div')
  emptyHint.className = 'scripts-detail-empty'
  emptyHint.textContent = i18nT('scripts.runHint')
  detail.append(emptyHint, termWrap)

  root.append(cs.element, cs.resizer, detail)

  // ---- embedded terminal (created on first use) ----
  let term: TerminalPanelHandle | undefined
  const hideTerm = (): void => {
    termWrap.classList.add('hidden')
    emptyHint.classList.remove('hidden')
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
    emptyHint.classList.add('hidden')
    requestAnimationFrame(() => term!.fit())
  }

  const run = (path: string): void => {
    showTerm()
    ensureTerm().sendInput(scriptCommand(path))
  }

  // Fit the terminal to the right pane on any resize (sidebar drag, panel resize).
  new ResizeObserver(() => term?.fit()).observe(detail)

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
      hint.textContent = i18nT('scripts.addAFolderToListYourScripts')
      listEl.appendChild(hint)
      return
    }
    const shown = filter ? files.filter(f => f.dir === filter) : files
    if (!shown.length) {
      const empty = document.createElement('div')
      empty.className = 'scripts-hint'
      empty.textContent = i18nT('scripts.noScriptsInTheseFolders')
      listEl.appendChild(empty)
      return
    }
    shown.forEach(f => {
      const row = document.createElement('button')
      row.className = 'scripts-item'
      row.title = i18nT('scripts.runCommand', { command: scriptCommand(f.path) })
      const iconSlot = document.createElement('span')
      iconSlot.innerHTML = icon('play')
      const name = document.createElement('span')
      name.className = 'scripts-item-name'
      name.textContent = f.name
      const directory = document.createElement('span')
      directory.className = 'scripts-item-dir'
      directory.textContent = f.dir
      row.append(iconSlot, name, directory)
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
