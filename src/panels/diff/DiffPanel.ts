import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { createMasterDetail } from '../../ui/masterDetail'
import { renderPatchHtml, buildCommitFileList } from '../tasks/TaskCodeView'
import { icon } from '../../ui/icons'
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

export function createDiffPanel(sessionPath?: string, panelId?: string): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'diff-panel'

  const repoKey = diffRepoStorageKey(sessionPath, panelId)
  // '' = legacy mode → restore last repo from bento.diff.repo; any other value → start empty
  let repoPath = sessionPath === '' ? (localStorage.getItem(repoKey) ?? '') : ''
  let mode: Mode = 'worktree'
  let logEntries: CommitEntry[] = []
  let worktreeChunks = new Map<string, string>()

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div')
  toolbar.className = 'diff-toolbar'

  const worktreeBtn = Object.assign(document.createElement('button'), {
    className: 'diff-mode-btn diff-mode-btn--active',
    textContent: diffT('worktreeMode'),
  })
  const logBtn = Object.assign(document.createElement('button'), {
    className: 'diff-mode-btn',
    textContent: diffT('logMode'),
  })
  const refreshBtn = Object.assign(document.createElement('button'), {
    className: 'diff-icon-btn',
    title: diffT('refresh'),
    innerHTML: icon('refresh'),
  })
  const openBtn = Object.assign(document.createElement('button'), {
    className: 'diff-open-btn',
    textContent: diffT('openRepo'),
    innerHTML: icon('folder') + `<span>${diffT('openRepo')}</span>`,
  })
  const repoSelect = document.createElement('select')
  repoSelect.className = 'diff-repo-select hidden'

  toolbar.append(worktreeBtn, logBtn, refreshBtn, repoSelect, openBtn)

  // ── Master-detail ─────────────────────────────────────────────────────────
  const md = createMasterDetail({
    title: '',
    onSelect: id => showItem(id),
    emptyText: diffT('noFiles'),
  })

  // ── Empty state (no repo) ─────────────────────────────────────────────────
  const emptyState = document.createElement('div')
  emptyState.className = 'diff-empty-state'
  const emptyTitle = Object.assign(document.createElement('p'), {
    className: 'diff-empty-title',
    textContent: diffT('noRepo'),
  })
  const emptyHint = Object.assign(document.createElement('p'), {
    className: 'diff-empty-hint',
    textContent: diffT('noRepoHint'),
  })
  const emptyOpenBtn = Object.assign(document.createElement('button'), {
    className: 'diff-empty-open-btn',
    textContent: diffT('openRepo'),
  })
  emptyState.append(emptyTitle, emptyHint, emptyOpenBtn)

  root.append(toolbar, md.element, emptyState)

  // ── Visibility helpers ────────────────────────────────────────────────────
  const showEmpty = (on: boolean): void => {
    emptyState.classList.toggle('hidden', !on)
    md.element.classList.toggle('hidden', on)
    emptyState.style.display = on ? 'flex' : 'none'
    md.element.style.display = on ? 'none' : 'flex'
  }

  // ── Item detail ───────────────────────────────────────────────────────────
  const showItem = async (id: string): Promise<void> => {
    md.detail.replaceChildren()
    if (mode === 'worktree') {
      const chunk = worktreeChunks.get(id) ?? ''
      const pre = document.createElement('pre')
      pre.className = 'diff-patch'
      pre.innerHTML = renderPatchHtml(chunk)
      md.detail.appendChild(pre)
    } else {
      const entry = logEntries.find(e => e.hash === id)
      if (!entry) return
      md.detail.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'diff-hint', textContent: diffT('loading') }),
      )
      try {
        const files = await diffGit.files(repoPath, entry.hash)
        const nodes = buildCommitFileList(
          files,
          file => diffGit.showDiff(repoPath, entry.hash, file),
          file => diffGit.showFile(repoPath, entry.hash, file),
        )
        md.detail.replaceChildren(...nodes)
      } catch (e) {
        md.detail.textContent = String(e)
      }
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    if (!repoPath) { showEmpty(true); return }
    showEmpty(false)
    worktreeChunks = new Map()
    logEntries = []
    md.detail.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'diff-hint', textContent: diffT('loading') }),
    )

    if (mode === 'worktree') {
      try {
        const raw = await diffGit.diff(repoPath)
        const files = parseDiffFiles(raw)
        if (!files.length) {
          md.setItems([])
          md.detail.replaceChildren(
            Object.assign(document.createElement('div'), { className: 'diff-hint', textContent: diffT('noChanges') }),
          )
          return
        }
        for (const f of files) worktreeChunks.set(f.file, f.chunk)
        md.setItems(files.map(f => ({
          id: f.file,
          label: f.file,
          group: '',
          leading: buildStatsBadge(f.additions, f.deletions),
        })))
        if (files[0]) { md.select(files[0].file); showItem(files[0].file) }
      } catch (e) {
        md.detail.textContent = String(e)
      }
    } else {
      try {
        logEntries = await diffGit.log(repoPath)
        md.setItems(logEntries.map(e => ({
          id: e.hash,
          label: e.subject,
          group: e.date,
          leading: Object.assign(document.createElement('span'), {
            className: 'diff-short',
            textContent: e.short,
          }),
        })))
        if (logEntries[0]) { md.select(logEntries[0].hash); showItem(logEntries[0].hash) }
      } catch (e) {
        md.detail.textContent = String(e)
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
