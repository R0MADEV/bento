import { invoke } from '@tauri-apps/api/core'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { icon } from '../../ui/icons'
import { buildChangesFileView } from '../tasks/ChangesFileView'
import { buildSelectedPatch } from '../../core/git/commitWorkflow'
import { diffGit } from '../diff/diffGitClient'
import { buildReviewFiles, reviewSummary } from './reviewFiles'
import { reviewT } from './i18n'

type Mode = 'branch' | 'worktree'

const REPO_KEY = 'bento.review.repo'
const BASE_KEY = 'bento.review.base'
const INTERVAL_MS = 5000

export function createReviewPanel(sessionPath?: string): { element: HTMLElement; dispose?: () => void } {
  const root = document.createElement('div')
  root.className = 'review-panel'

  let repoPath: string = sessionPath ?? localStorage.getItem(REPO_KEY) ?? ''
  let mode: Mode = 'branch'
  let baseBranch = localStorage.getItem(BASE_KEY) ?? 'main'
  let autoRefresh = false
  let intervalId: ReturnType<typeof setInterval> | null = null
  let allBranches: string[] = []
  let worktreeDiff = ''
  const checkedFiles = new Set<string>()
  const selectedHunks = new Map<string, Set<number>>()

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div')
  toolbar.className = 'review-toolbar'

  // Mode toggle
  const branchBtn = Object.assign(document.createElement('button'), {
    className: 'review-mode-btn review-mode-btn--active',
    textContent: reviewT('modeBranch'),
  })
  const worktreeBtn = Object.assign(document.createElement('button'), {
    className: 'review-mode-btn',
    textContent: reviewT('modeWorktree'),
  })

  // Branch info row (only shown in branch mode)
  const branchBar = document.createElement('div')
  branchBar.className = 'review-branch-bar'

  const baseLabel = Object.assign(document.createElement('span'), {
    className: 'review-base-label',
    textContent: reviewT('baseBranch'),
  })
  const branchWrap = document.createElement('div')
  branchWrap.className = 'review-branch-wrap'
  const branchInput = Object.assign(document.createElement('input'), {
    className: 'review-branch-input',
    type: 'text',
    value: baseBranch,
    placeholder: 'main',
  })
  const branchDropdown = document.createElement('div')
  branchDropdown.className = 'review-branch-dropdown hidden'
  branchWrap.append(branchInput, branchDropdown)
  const currentBranchEl = Object.assign(document.createElement('span'), { className: 'review-current-branch' })

  branchBar.append(baseLabel, branchWrap, currentBranchEl)

  // Right-side actions
  const openBtn = Object.assign(document.createElement('button'), {
    className: 'review-icon-btn',
    title: reviewT('openRepo'),
    innerHTML: icon('folder'),
  })
  const refreshBtn = Object.assign(document.createElement('button'), {
    className: 'review-refresh-btn review-icon-btn',
    title: reviewT('refresh'),
    innerHTML: icon('refresh'),
  })
  const autoBtn = Object.assign(document.createElement('button'), {
    className: 'review-icon-btn',
    title: reviewT('autoRefresh'),
    innerHTML: icon('eye'),
  })
  const summary = Object.assign(document.createElement('span'), { className: 'review-summary' })

  toolbar.append(branchBtn, worktreeBtn, branchBar, summary, openBtn, refreshBtn, autoBtn)

  // ── File list ─────────────────────────────────────────────────────────────
  const fileList = document.createElement('div')
  fileList.className = 'review-files'

  // ── Empty state (no repo) ─────────────────────────────────────────────────
  const emptyState = document.createElement('div')
  emptyState.className = 'review-empty-state'
  const emptyOpenBtn = Object.assign(document.createElement('button'), {
    className: 'review-empty-open-btn',
    textContent: reviewT('openRepo'),
  })
  emptyState.append(
    Object.assign(document.createElement('p'), { className: 'review-empty-title', textContent: reviewT('noRepo') }),
    Object.assign(document.createElement('p'), { className: 'review-empty-hint', textContent: reviewT('noRepoHint') }),
    emptyOpenBtn,
  )

  // ── Commit bar (only in worktree mode) ───────────────────────────────────
  const commitBar = document.createElement('div')
  commitBar.className = 'review-commit-bar hidden'
  const msgInput = Object.assign(document.createElement('input'), {
    className: 'review-commit-msg',
    type: 'text',
    placeholder: reviewT('commitMessage'),
  })
  const commitBtn = Object.assign(document.createElement('button'), {
    className: 'review-commit-btn',
    textContent: reviewT('commit'),
  })
  const statusEl = Object.assign(document.createElement('span'), { className: 'review-commit-status' })
  commitBar.append(msgInput, commitBtn, statusEl)

  root.append(toolbar, emptyState, fileList, commitBar)

  // ── Helpers ───────────────────────────────────────────────────────────────
  const setEmptyVisible = (on: boolean): void => {
    emptyState.classList.toggle('hidden', !on)
    fileList.classList.toggle('hidden', on)
  }

  const showStatus = (text: string, isError = false): void => {
    statusEl.textContent = text
    statusEl.className = `review-commit-status ${isError ? 'review-commit-err' : 'review-commit-ok'}`
    setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'review-commit-status' }, isError ? 5000 : 3000)
  }

  const renderPatch = (raw: string): string =>
    raw.split('\n').map((line, i) => {
      const cls = line.startsWith('+') && !line.startsWith('+++') ? ' tasks-diff-line-add'
        : line.startsWith('-') && !line.startsWith('---') ? ' tasks-diff-line-del'
          : line.startsWith('@@') ? ' tasks-diff-hunk' : ''
      const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<span class="tasks-diff-code-line${cls}"><span class="tasks-diff-line-no">${i + 1}</span>${esc}</span>`
    }).join('')

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = async (): Promise<void> => {
    if (!repoPath) { setEmptyVisible(true); return }
    setEmptyVisible(false)
    fileList.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }),
    )

    try {
      let diffRaw: string
      if (mode === 'branch') {
        diffRaw = await diffGit.branchDiff(repoPath, baseBranch)
      } else {
        const status = await diffGit.status(repoPath)
        diffRaw = await diffGit.diff(repoPath)
        worktreeDiff = diffRaw
        const files = buildReviewFiles(diffRaw, status.raw)
        renderFiles(files)
        return
      }

      const files = buildReviewFiles(diffRaw, '')
      renderFiles(files)
    } catch (e) {
      fileList.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'review-error', textContent: String(e) }),
      )
    }
  }

  const renderFiles = (files: ReturnType<typeof buildReviewFiles>): void => {
    const s = reviewSummary(files)
    summary.textContent = files.length ? reviewT('files', { count: s.files }) : ''

    if (!files.length) {
      const msg = mode === 'branch'
        ? reviewT('noBranchChanges', { base: baseBranch })
        : reviewT('noChanges')
      fileList.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: msg }),
      )
      return
    }

    checkedFiles.clear()
    selectedHunks.clear()

    fileList.replaceChildren(...files.map(f =>
      buildChangesFileView({
        chunk: f.chunk,
        state: f.state,
        checkedFiles,
        selectedHunks,
        renderPatch,
      }),
    ))
  }

  // ── Mode toggle ───────────────────────────────────────────────────────────
  const setMode = (next: Mode): void => {
    mode = next
    branchBtn.classList.toggle('review-mode-btn--active', mode === 'branch')
    worktreeBtn.classList.toggle('review-mode-btn--active', mode === 'worktree')
    branchBar.classList.toggle('hidden', mode !== 'branch')
    commitBar.classList.toggle('hidden', mode !== 'worktree')
    load()
  }

  branchBtn.addEventListener('click', () => setMode('branch'))
  worktreeBtn.addEventListener('click', () => setMode('worktree'))

  // ── Base branch selector ──────────────────────────────────────────────────
  const DROPDOWN_MAX = 20

  const renderDropdown = (): void => {
    const q = branchInput.value.toLowerCase()
    const matches = q ? allBranches.filter(b => b.toLowerCase().includes(q)) : allBranches
    const top = matches.slice(0, DROPDOWN_MAX)
    branchDropdown.replaceChildren(...top.map(b => {
      const item = Object.assign(document.createElement('div'), {
        className: `review-branch-option${b === baseBranch ? ' review-branch-option--active' : ''}`,
        textContent: b,
      })
      item.addEventListener('mousedown', e => {
        e.preventDefault()
        baseBranch = b
        branchInput.value = b
        localStorage.setItem(BASE_KEY, baseBranch)
        branchDropdown.classList.add('hidden')
        load()
      })
      return item
    }))
    branchDropdown.classList.toggle('hidden', top.length === 0)
  }

  branchInput.addEventListener('focus', renderDropdown)
  branchInput.addEventListener('input', renderDropdown)
  branchInput.addEventListener('blur', () => setTimeout(() => branchDropdown.classList.add('hidden'), 150))
  const commitRef = (raw: string): void => {
    const next = raw.trim().replace(':', '/')
    branchInput.value = next
    if (!next || next === baseBranch) return
    baseBranch = next
    localStorage.setItem(BASE_KEY, baseBranch)
    load()
  }

  branchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { branchDropdown.classList.add('hidden'); return }
    if (e.key === 'Enter') { branchDropdown.classList.add('hidden'); commitRef(branchInput.value) }
  })
  branchInput.addEventListener('change', () => commitRef(branchInput.value))

  const loadBranches = async (): Promise<void> => {
    if (!repoPath) return
    const [defaultBranch, branches, currentBranch] = await Promise.all([
      diffGit.defaultBranch(repoPath),
      diffGit.remoteBranches(repoPath),
      invoke<string>('git_current_branch', { path: repoPath }).catch(() => ''),
    ])
    allBranches = branches
    currentBranchEl.textContent = currentBranch ? `on ${currentBranch}` : ''

    const isCurrentBranch = (b: string): boolean =>
      !!currentBranch && (b === currentBranch || b === `origin/${currentBranch}`)

    const originDefault = `origin/${defaultBranch}`
    const needsReset = !baseBranch || isCurrentBranch(baseBranch)
    if (needsReset) {
      const candidate = branches.find(b => !isCurrentBranch(b) && (b === originDefault || b === defaultBranch))
        ?? branches.find(b => !isCurrentBranch(b))
        ?? defaultBranch
      baseBranch = candidate
      branchInput.value = baseBranch
      localStorage.setItem(BASE_KEY, baseBranch)
    }
  }

  // ── Auto-refresh ──────────────────────────────────────────────────────────
  const setAutoRefresh = (on: boolean): void => {
    autoRefresh = on
    autoBtn.classList.toggle('review-icon-btn--active', on)
    if (intervalId) { clearInterval(intervalId); intervalId = null }
    if (on) intervalId = setInterval(load, INTERVAL_MS)
  }

  // ── Commit (worktree mode only) ───────────────────────────────────────────
  commitBtn.addEventListener('click', async () => {
    const msg = msgInput.value.trim()
    if (!msg) { msgInput.focus(); return }
    commitBtn.disabled = true
    try {
      const patch = buildSelectedPatch(worktreeDiff, checkedFiles, selectedHunks)
      await invoke('git_commit', { path: repoPath, message: msg, patch: patch || undefined })
      msgInput.value = ''
      checkedFiles.clear()
      selectedHunks.clear()
      showStatus(reviewT('committed'))
      load()
    } catch (e) {
      showStatus(String(e), true)
    } finally {
      commitBtn.disabled = false
    }
  })

  // ── Repo picker ───────────────────────────────────────────────────────────
  const pickRepo = async (): Promise<void> => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked
    baseBranch = ''
    branchInput.value = ''
    localStorage.setItem(REPO_KEY, repoPath)
    checkedFiles.clear()
    selectedHunks.clear()
    setEmptyVisible(false)
    fileList.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }),
    )
    await loadBranches()
    load()
  }

  openBtn.addEventListener('click', pickRepo)
  emptyOpenBtn.addEventListener('click', pickRepo)
  refreshBtn.addEventListener('click', () => load())
  autoBtn.addEventListener('click', () => setAutoRefresh(!autoRefresh))

  // ── Init ──────────────────────────────────────────────────────────────────
  branchBar.classList.remove('hidden')
  commitBar.classList.add('hidden')

  if (repoPath) {
    setEmptyVisible(false)
    fileList.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }),
    )
    loadBranches().then(() => load())
  } else {
    setEmptyVisible(true)
  }

  return {
    element: root,
    dispose: () => { if (intervalId) clearInterval(intervalId) },
  }
}
