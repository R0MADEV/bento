import { invoke } from '@tauri-apps/api/core'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/icons'
import { parseDiffFiles } from '../diff/diffStats'
import { diffGit } from '../diff/diffGitClient'
import { reviewT } from './i18n'

const REPO_KEY = 'bento.review.repo'
const BASE_KEY = 'bento.review.base'

export function createReviewPanel(sessionPath?: string): { element: HTMLElement; dispose?: () => void } {
  const root = document.createElement('div')
  root.className = 'review-panel'

  let repoPath: string = sessionPath ?? localStorage.getItem(REPO_KEY) ?? ''
  let baseBranch = localStorage.getItem(BASE_KEY) ?? ''
  let selectedBranch = ''
  let allBranches: string[] = []
  let currentPrNumber: number | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  let autoRefresh = false

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div')
  toolbar.className = 'review-toolbar'

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
    placeholder: 'origin/main',
  })
  const branchDropdown = document.createElement('div')
  branchDropdown.className = 'review-branch-dropdown hidden'
  branchWrap.append(branchInput, branchDropdown)

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

  toolbar.append(baseLabel, branchWrap, openBtn, refreshBtn, autoBtn)

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.className = 'review-body'

  // Sidebar: list of branches
  const sidebar = document.createElement('div')
  sidebar.className = 'review-sidebar'

  const branchSearch = Object.assign(document.createElement('input'), {
    className: 'review-branch-search',
    type: 'text',
    placeholder: 'Filter…',
  })
  const branchList = document.createElement('div')
  branchList.className = 'review-branch-list'
  sidebar.append(branchSearch, branchList)

  // Detail: diff + comment
  const detail = document.createElement('div')
  detail.className = 'review-detail'

  const diffView = document.createElement('div')
  diffView.className = 'review-diff-view'

  const commentBar = document.createElement('div')
  commentBar.className = 'review-comment-bar hidden'

  const prInfoEl = Object.assign(document.createElement('div'), { className: 'review-pr-info' })
  const commentInput = document.createElement('textarea')
  commentInput.className = 'review-comment-input'
  commentInput.placeholder = reviewT('commentPlaceholder')
  commentInput.rows = 3
  const commentBtn = Object.assign(document.createElement('button'), {
    className: 'review-comment-btn',
    textContent: reviewT('sendComment'),
  })
  const commentStatus = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
  commentBar.append(prInfoEl, commentInput, commentBtn, commentStatus)

  detail.append(diffView, commentBar)
  body.append(sidebar, detail)

  // ── Empty state ───────────────────────────────────────────────────────────
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

  root.append(toolbar, emptyState, body)

  // ── Helpers ───────────────────────────────────────────────────────────────
  const setEmptyVisible = (on: boolean): void => {
    emptyState.classList.toggle('hidden', !on)
    body.classList.toggle('hidden', on)
  }

  const showSentLink = (el: HTMLElement, url: string): void => {
    el.replaceChildren()
    el.className = 'review-comment-status review-comment-ok'
    if (url) {
      const a = Object.assign(document.createElement('a'), {
        className: 'review-pr-link',
        textContent: reviewT('commentSent') + ' →',
        href: '#',
      })
      a.addEventListener('click', e => { e.preventDefault(); openUrl(url).catch(() => {}) })
      el.append(a)
    } else {
      el.textContent = reviewT('commentSent')
    }
  }

  const showCommentStatus = (text: string, isError = false): void => {
    commentStatus.textContent = text
    commentStatus.className = `review-comment-status ${isError ? 'review-comment-err' : 'review-comment-ok'}`
    setTimeout(() => { commentStatus.textContent = ''; commentStatus.className = 'review-comment-status' }, isError ? 5000 : 3000)
  }

  // ── Branch sidebar ────────────────────────────────────────────────────────
  const renderBranchList = (): void => {
    const q = branchSearch.value.toLowerCase()
    const visible = q ? allBranches.filter(b => b.toLowerCase().includes(q)) : allBranches
    branchList.replaceChildren(...visible.slice(0, 50).map(b => {
      const item = Object.assign(document.createElement('div'), {
        className: `review-branch-item${b === selectedBranch ? ' review-branch-item--active' : ''}`,
        textContent: b,
        title: b,
      })
      item.addEventListener('click', () => selectBranch(b))
      return item
    }))
  }

  branchSearch.addEventListener('input', renderBranchList)

  // ── Base dropdown ─────────────────────────────────────────────────────────
  const renderBaseDropdown = (): void => {
    const q = branchInput.value.toLowerCase()
    const matches = q ? allBranches.filter(b => b.toLowerCase().includes(q)) : allBranches
    branchDropdown.replaceChildren(...matches.slice(0, 20).map(b => {
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
        if (selectedBranch) loadDiff()
      })
      return item
    }))
    branchDropdown.classList.toggle('hidden', matches.length === 0)
  }

  branchInput.addEventListener('focus', renderBaseDropdown)
  branchInput.addEventListener('input', renderBaseDropdown)
  branchInput.addEventListener('blur', () => setTimeout(() => branchDropdown.classList.add('hidden'), 150))
  branchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { branchDropdown.classList.add('hidden'); return }
    if (e.key === 'Enter') {
      branchDropdown.classList.add('hidden')
      const next = branchInput.value.trim().replace(':', '/')
      branchInput.value = next
      if (next && next !== baseBranch) { baseBranch = next; localStorage.setItem(BASE_KEY, baseBranch); if (selectedBranch) loadDiff() }
    }
  })

  // Strips remote prefix: "origin/feat/foo" → "feat/foo"
  const ghBranch = (b: string): string => b.replace(/^[^/]+\//, '')

  // ── Select branch → load diff + PR ───────────────────────────────────────
  const selectBranch = (branch: string): void => {
    selectedBranch = branch
    renderBranchList()
    loadDiff()
    loadPrInfo()
  }

  const makeLineForm = (filePath: string, line: number): HTMLElement => {
    const form = document.createElement('div')
    form.className = 'review-line-form'
    const input = document.createElement('textarea')
    input.className = 'review-comment-input'
    input.placeholder = reviewT('commentPlaceholder')
    input.rows = 3
    const actions = document.createElement('div')
    actions.className = 'review-line-form-actions'
    const sendBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: reviewT('sendComment') })
    const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
    const status = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
    actions.append(cancelBtn, sendBtn, status)
    form.append(input, actions)

    cancelBtn.addEventListener('click', () => form.remove())
    sendBtn.addEventListener('click', async () => {
      const body = input.value.trim()
      if (!body) { input.focus(); return }
      if (currentPrNumber === null) { status.textContent = 'No PR for this branch'; return }
      sendBtn.disabled = true
      try {
        const commitId = await invoke<string>('git_rev_parse', { path: repoPath, reference: selectedBranch })
        const url = await invoke<string>('gh_pr_inline_comment', { path: repoPath, prNumber: currentPrNumber, commitId, file: filePath, line, body })
        input.value = ''
        showSentLink(status, url)
        setTimeout(() => form.remove(), 4000)
      } catch (err) {
        status.textContent = String(err)
        status.className = 'review-comment-status review-comment-err'
      } finally {
        sendBtn.disabled = false
      }
    })
    return form
  }

  const buildFileDiff = (chunk: string, filePath: string): HTMLElement => {
    const container = document.createElement('div')
    let newLine = 0

    for (const raw of chunk.split('\n')) {
      const isAdd = raw.startsWith('+') && !raw.startsWith('+++')
      const isDel = raw.startsWith('-') && !raw.startsWith('---')
      const isHunk = raw.startsWith('@@')
      const isMeta = raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')

      if (isHunk) {
        const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
        if (m) newLine = parseInt(m[1], 10) - 1
      }

      let fileLine: number | null = null
      if (isAdd) { newLine++; fileLine = newLine }
      else if (!isDel && !isHunk && !isMeta) { newLine++; fileLine = newLine }

      const cls = isAdd ? ' tasks-diff-line-add' : isDel ? ' tasks-diff-line-del' : isHunk ? ' tasks-diff-hunk' : ''
      const esc = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

      const wrap = document.createElement('div')
      wrap.className = 'review-diff-line-wrap'

      const lineEl = document.createElement('div')
      lineEl.className = `tasks-diff-code-line${cls}`

      if (fileLine !== null) {
        const addBtn = Object.assign(document.createElement('button'), {
          className: 'review-line-comment-btn',
          textContent: '+',
          title: `Comment line ${fileLine}`,
        })
        const capturedLine = fileLine
        addBtn.addEventListener('click', () => {
          wrap.querySelectorAll('.review-line-form').forEach(el => el.remove())
          const form = makeLineForm(filePath, capturedLine)
          wrap.append(form)
          form.querySelector('textarea')?.focus()
        })
        lineEl.append(addBtn)
      }

      const content = document.createElement('span')
      content.innerHTML = `<span class="tasks-diff-line-no">${fileLine ?? ''}</span>${esc}`
      lineEl.append(content)
      wrap.append(lineEl)
      container.append(wrap)
    }
    return container
  }

  const loadDiff = async (): Promise<void> => {
    diffView.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }),
    )
    try {
      const raw = await invoke<string>('git_ref_diff', { path: repoPath, base: baseBranch, target: selectedBranch })
      if (!raw.trim()) {
        diffView.replaceChildren(
          Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: reviewT('noBranchChanges', { base: baseBranch }) }),
        )
        return
      }
      const files = parseDiffFiles(raw)
      diffView.replaceChildren(...files.map(f => {
        const details = document.createElement('details')
        details.className = 'review-file-detail'
        details.open = files.length <= 5
        const sum = Object.assign(document.createElement('summary'), {
          className: 'review-file-summary',
          textContent: f.file,
        })
        details.append(sum, buildFileDiff(f.chunk, f.file))
        return details
      }))
    } catch (e) {
      diffView.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'review-error', textContent: String(e) }),
      )
    }
  }

  const loadPrInfo = async (): Promise<void> => {
    currentPrNumber = null
    prInfoEl.replaceChildren()
    commentBar.classList.add('hidden')
    try {
      const pr = await invoke<{ number: number; title: string; url: string } | null>('gh_pr_view_branch', {
        path: repoPath,
        branch: ghBranch(selectedBranch),
      })
      if (pr) {
        currentPrNumber = pr.number
        const link = Object.assign(document.createElement('a'), {
          className: 'review-pr-link',
          textContent: `PR #${pr.number}: ${pr.title}`,
          href: '#',
        })
        link.addEventListener('click', e => { e.preventDefault(); openUrl(pr.url).catch(() => {}) })
        prInfoEl.append(link)
        commentBar.classList.remove('hidden')
      }
    } catch { /* no PR */ }
  }

  // Identifier to pass to gh: PR number if known, else branch name
  const prIdentifier = (): string =>
    currentPrNumber !== null ? String(currentPrNumber) : ghBranch(selectedBranch)

  // ── Send PR comment ───────────────────────────────────────────────────────
  commentBtn.addEventListener('click', async () => {
    const body = commentInput.value.trim()
    if (!body) { commentInput.focus(); return }
    commentBtn.disabled = true
    try {
      const url = await invoke<string>('gh_pr_comment', { path: repoPath, branch: prIdentifier(), body })
      commentInput.value = ''
      showSentLink(commentStatus, url)
    } catch (e) {
      showCommentStatus(String(e), true)
    } finally {
      commentBtn.disabled = false
    }
  })

  // ── Load branches ─────────────────────────────────────────────────────────
  const loadBranches = async (): Promise<void> => {
    if (!repoPath) return
    const [defaultBranch, branches] = await Promise.all([
      diffGit.defaultBranch(repoPath),
      diffGit.remoteBranches(repoPath),
    ])
    allBranches = branches
    if (!baseBranch) {
      const originDefault = `origin/${defaultBranch}`
      baseBranch = branches.includes(originDefault) ? originDefault : (branches[0] ?? defaultBranch)
      branchInput.value = baseBranch
      localStorage.setItem(BASE_KEY, baseBranch)
    }
    renderBranchList()
  }

  // ── Auto-refresh ──────────────────────────────────────────────────────────
  const setAutoRefresh = (on: boolean): void => {
    autoRefresh = on
    autoBtn.classList.toggle('review-icon-btn--active', on)
    if (intervalId) { clearInterval(intervalId); intervalId = null }
    if (on) intervalId = setInterval(() => { if (selectedBranch) loadDiff() }, 5000)
  }

  // ── Repo picker ───────────────────────────────────────────────────────────
  const pickRepo = async (): Promise<void> => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked
    baseBranch = ''
    branchInput.value = ''
    selectedBranch = ''
    localStorage.setItem(REPO_KEY, repoPath)
    setEmptyVisible(false)
    diffView.replaceChildren()
    commentBar.classList.add('hidden')
    await loadBranches()
  }

  openBtn.addEventListener('click', pickRepo)
  emptyOpenBtn.addEventListener('click', pickRepo)
  refreshBtn.addEventListener('click', () => { loadBranches(); if (selectedBranch) loadDiff() })
  autoBtn.addEventListener('click', () => setAutoRefresh(!autoRefresh))

  // ── Init ──────────────────────────────────────────────────────────────────
  if (repoPath) {
    setEmptyVisible(false)
    diffView.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: reviewT('selectBranch') }),
    )
    loadBranches()
  } else {
    setEmptyVisible(true)
  }

  return {
    element: root,
    dispose: () => { if (intervalId) clearInterval(intervalId) },
  }
}
