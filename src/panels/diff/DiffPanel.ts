import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { renderPatchHtml, buildCommitFileList } from '../tasks/TaskCodeView'
import { icon } from '../../ui/helpers/icons'
import type { CommitEntry } from '../tasks/gitTypes'
import { parseDiffFiles } from './diffStats'
import { diffGit } from './diffGitClient'
import { diffT } from './i18n'

type Mode = 'worktree' | 'log'

const REPO_KEY = 'bento.diff.repo'

export const diffRepoStorageKey = (sessionPath?: string, panelId?: string): string => {
  if (!sessionPath) return REPO_KEY
  const scope = panelId ? JSON.stringify({ path: sessionPath, panelId }) : sessionPath
  return `${REPO_KEY}.${encodeURIComponent(scope)}`
}

export const diffRepoPathsFromKeys = (keys: string[]): string[] => keys
  .filter(key => key.startsWith(`${REPO_KEY}.`))
  .map(key => {
    try {
      const value = JSON.parse(decodeURIComponent(key.slice(`${REPO_KEY}.`.length))) as { path?: string }
      return value.path ?? ''
    } catch {
      try { return decodeURIComponent(key.slice(`${REPO_KEY}.`.length)) } catch { return '' }
    }
  })
  .filter((path, index, paths) => path !== '' && paths.indexOf(path) === index)

// A row in the left list: a changed file (worktree mode) or a commit (log mode).
interface DiffRow { id: string; label: string; group: string; leading?: HTMLElement }

export function createDiffPanel(sessionPath?: string, panelId?: string): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'diff-panel'

  const repoKey = diffRepoStorageKey(sessionPath, panelId)
  // '' = legacy mode → restore last repo from bento.diff.repo; any other value → start empty
  let repoPath = sessionPath === '' ? (localStorage.getItem(repoKey) ?? '') : ''
  let mode: Mode = 'worktree'
  let logEntries: CommitEntry[] = []
  let worktreeChunks = new Map<string, string>()
  let rows: DiffRow[] = []
  let selectedId = ''

  // ── Layout: collapsible sidebar (all controls + list) + free detail pane ────
  const body = document.createElement('div')
  body.className = 'diff-body'

  const cs = createCollapsibleSidebar({
    storageKey: `bento.diff.${panelId ?? sessionPath ?? 'default'}.sidebar`,
    title: diffT('title'),
    defaultWidth: 240,
    minWidth: 180,
    minRemaining: 320,
    container: body,
  })
  // Fixed controls on top, scrolling list below.
  Object.assign(cs.list.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column' })

  // Header actions (open repo · refresh) sit in the sidebar header, by the toggle.
  const refreshBtn = Object.assign(document.createElement('button'), {
    className: 'diff-icon-btn', title: diffT('refresh'), innerHTML: icon('refresh'),
  })
  const openBtn = Object.assign(document.createElement('button'), {
    className: 'diff-icon-btn', title: diffT('openRepo'), innerHTML: icon('folder'),
  })
  cs.actions.append(openBtn, refreshBtn)

  // Controls row: mode toggle (worktree/log) + repo selector.
  const controls = document.createElement('div')
  controls.className = 'diff-controls'
  const worktreeBtn = Object.assign(document.createElement('button'), {
    className: 'diff-mode-btn diff-mode-btn--active', textContent: diffT('worktreeMode'),
  })
  const logBtn = Object.assign(document.createElement('button'), {
    className: 'diff-mode-btn', textContent: diffT('logMode'),
  })
  const modeToggle = document.createElement('div')
  modeToggle.className = 'diff-mode-toggle'
  modeToggle.append(worktreeBtn, logBtn)
  const repoSelect = document.createElement('select')
  repoSelect.className = 'diff-repo-select hidden'
  controls.append(modeToggle, repoSelect)

  const listWrap = document.createElement('div')
  listWrap.className = 'diff-list'
  cs.list.append(controls, listWrap)

  const detail = document.createElement('div')
  detail.className = 'diff-detail'

  body.append(cs.element, cs.resizer, detail)

  // ── Empty state (no repo) ─────────────────────────────────────────────────
  const emptyState = document.createElement('div')
  emptyState.className = 'diff-empty-state'
  const emptyTitle = Object.assign(document.createElement('p'), {
    className: 'diff-empty-title', textContent: diffT('noRepo'),
  })
  const emptyHint = Object.assign(document.createElement('p'), {
    className: 'diff-empty-hint', textContent: diffT('noRepoHint'),
  })
  const emptyOpenBtn = Object.assign(document.createElement('button'), {
    className: 'diff-empty-open-btn', textContent: diffT('openRepo'),
  })
  emptyState.append(emptyTitle, emptyHint, emptyOpenBtn)

  root.append(body, emptyState)

  const showEmpty = (on: boolean): void => {
    emptyState.classList.toggle('hidden', !on)
    body.classList.toggle('hidden', on)
    emptyState.style.display = on ? 'flex' : 'none'
    body.style.display = on ? 'none' : 'flex'
  }

  const hint = (text: string): HTMLElement =>
    Object.assign(document.createElement('div'), { className: 'diff-hint', textContent: text })

  // ── Left list (grouped, selectable) ─────────────────────────────────────────
  const refreshMini = (): void => {
    cs.setMiniItems(rows.map(r => ({
      label: r.label,
      active: r.id === selectedId,
      onClick: () => selectRow(r.id),
    })))
  }

  const updateSelected = (): void => {
    listWrap.querySelectorAll<HTMLElement>('.diff-row').forEach(el => {
      el.classList.toggle('diff-row--selected', el.dataset.id === selectedId)
    })
  }

  const renderList = (): void => {
    listWrap.replaceChildren()
    let currentGroup: string | null = null
    for (const r of rows) {
      if (r.group && r.group !== currentGroup) {
        currentGroup = r.group
        listWrap.appendChild(Object.assign(document.createElement('div'), { className: 'diff-group', textContent: r.group }))
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'diff-row'
      row.dataset.id = r.id
      if (r.leading) row.appendChild(r.leading)
      row.appendChild(Object.assign(document.createElement('span'), { className: 'diff-row-label', textContent: r.label, title: r.label }))
      row.addEventListener('click', () => selectRow(r.id))
      listWrap.appendChild(row)
    }
    updateSelected()
    refreshMini()
  }

  const setItems = (next: DiffRow[]): void => { rows = next; renderList() }

  const selectRow = (id: string): void => {
    selectedId = id
    updateSelected()
    refreshMini()
    showItem(id)
  }

  // ── Item detail ───────────────────────────────────────────────────────────
  const showItem = async (id: string): Promise<void> => {
    detail.replaceChildren()
    if (mode === 'worktree') {
      const chunk = worktreeChunks.get(id) ?? ''
      const pre = document.createElement('pre')
      pre.className = 'diff-patch'
      pre.innerHTML = renderPatchHtml(chunk)
      detail.appendChild(pre)
    } else {
      const entry = logEntries.find(e => e.hash === id)
      if (!entry) return
      detail.replaceChildren(hint(diffT('loading')))
      try {
        const files = await diffGit.files(repoPath, entry.hash)
        const nodes = buildCommitFileList(
          files,
          file => diffGit.showDiff(repoPath, entry.hash, file),
          file => diffGit.showFile(repoPath, entry.hash, file),
        )
        detail.replaceChildren(...nodes)
      } catch (e) {
        detail.textContent = String(e)
      }
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    if (!repoPath) { showEmpty(true); return }
    showEmpty(false)
    worktreeChunks = new Map()
    logEntries = []
    selectedId = ''
    detail.replaceChildren(hint(diffT('loading')))

    if (mode === 'worktree') {
      try {
        const raw = await diffGit.diff(repoPath)
        const files = parseDiffFiles(raw)
        if (!files.length) {
          setItems([])
          detail.replaceChildren(hint(diffT('noChanges')))
          return
        }
        for (const f of files) worktreeChunks.set(f.file, f.chunk)
        setItems(files.map(f => ({
          id: f.file,
          label: f.file,
          group: '',
          leading: buildStatsBadge(f.additions, f.deletions),
        })))
        if (files[0]) selectRow(files[0].file)
      } catch (e) {
        detail.textContent = String(e)
      }
    } else {
      try {
        logEntries = await diffGit.log(repoPath)
        setItems(logEntries.map(e => ({
          id: e.hash,
          label: e.subject,
          group: e.date,
          leading: Object.assign(document.createElement('span'), {
            className: 'diff-short',
            textContent: e.short,
          }),
        })))
        if (logEntries[0]) selectRow(logEntries[0].hash)
      } catch (e) {
        detail.textContent = String(e)
      }
    }
  }

  // ── Mode toggle ───────────────────────────────────────────────────────────
  const setMode = (next: Mode): void => {
    mode = next
    worktreeBtn.classList.toggle('diff-mode-btn--active', mode === 'worktree')
    logBtn.classList.toggle('diff-mode-btn--active', mode === 'log')
    refresh()
  }

  worktreeBtn.addEventListener('click', () => setMode('worktree'))
  logBtn.addEventListener('click', () => setMode('log'))
  refreshBtn.addEventListener('click', () => refresh())

  // ── Folder picker ─────────────────────────────────────────────────────────
  const pickRepo = async (): Promise<void> => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked
    localStorage.setItem(repoKey, repoPath)
    refreshRepoOptions()
    refresh()
  }

  const refreshRepoOptions = (): void => {
    const paths = [
      sessionPath ?? '',
      localStorage.getItem(REPO_KEY) ?? '',
      ...diffRepoPathsFromKeys(Object.keys(localStorage)),
    ].filter((path, index, all) => path !== '' && all.indexOf(path) === index)
    repoSelect.replaceChildren(...paths.map(path => Object.assign(document.createElement('option'), {
      value: path,
      textContent: path.split('/').filter(Boolean).pop() ?? path,
      title: path,
    })))
    repoSelect.value = repoPath
    repoSelect.classList.toggle('hidden', paths.length < 2)
  }

  repoSelect.addEventListener('change', () => {
    repoPath = repoSelect.value
    if (repoPath) localStorage.setItem(repoKey, repoPath)
    refresh()
  })

  openBtn.addEventListener('click', pickRepo)
  emptyOpenBtn.addEventListener('click', pickRepo)

  // ── Initial render ────────────────────────────────────────────────────────
  refreshRepoOptions()
  refresh()

  return { element: root }
}

function buildStatsBadge(additions: number, deletions: number): HTMLElement {
  const el = document.createElement('span')
  el.className = 'diff-stats'
  if (additions) el.appendChild(Object.assign(document.createElement('span'), { className: 'diff-add', textContent: `+${additions}` }))
  if (deletions) el.appendChild(Object.assign(document.createElement('span'), { className: 'diff-del', textContent: `-${deletions}` }))
  return el
}
