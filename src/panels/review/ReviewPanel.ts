import { invoke } from '@tauri-apps/api/core'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/icons'
import { parseDiffFiles } from '../diff/diffStats'
import { diffGit } from '../diff/diffGitClient'
import { renderPatchHtml } from '../tasks/TaskCodeView'
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

  // Extracts the first changed line number from a diff chunk (new file side)
  const firstChangedLine = (chunk: string): number => {
    const match = chunk.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
    if (!match) return 1
    const start = parseInt(match[1], 10)
    const lines = chunk.split('\n')
    const hunkStart = lines.findIndex(l => l.startsWith('@@'))
    const offset = lines.slice(hunkStart + 1).findIndex(l => l.startsWith('+'))
    return start + (offset >= 0 ? offset : 0)
  }

  // ── Select branch → load diff + PR ───────────────────────────────────────
  const selectBranch = (branch: string): void => {
    selectedBranch = branch
    renderBranchList()
    loadDiff()
    loadPrInfo()
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

        const sum = document.createElement('summary')
        sum.className = 'review-file-summary'
        const fileName = Object.assign(document.createElement('span'), { textContent: f.file })
        const commentBtn = Object.assign(document.createElement('button'), {
          className: 'review-inline-comment-btn',
          title: reviewT('sendComment'),
          textContent: '💬',
        })
        sum.append(fileName, commentBtn)

        const pre = Object.assign(document.createElement('pre'), { className: 'tasks-diff-code' })
        pre.innerHTML = renderPatchHtml(f.chunk)

        // Inline comment form (hidden by default)
        const inlineForm = document.createElement('div')
        inlineForm.className = 'review-inline-form hidden'
        const inlineInput = document.createElement('textarea')
        inlineInput.className = 'review-comment-input'
        inlineInput.placeholder = reviewT('commentPlaceholder')
        inlineInput.rows = 3
        const inlineSend = Object.assign(document.createElement('button'), {
          className: 'review-comment-btn',
          textContent: reviewT('sendComment'),
        })
        const inlineStatus = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
        inlineForm.append(inlineInput, inlineSend, inlineStatus)

        commentBtn.addEventListener('click', e => {
          e.preventDefault()
          inlineForm.classList.toggle('hidden')
          if (!inlineForm.classList.contains('hidden')) inlineInput.focus()
        })

        inlineSend.addEventListener('click', async () => {
          const body = inlineInput.value.trim()
          if (!body) return
          inlineSend.disabled = true
          try {
            if (currentPrNumber !== null) {
              const commitId = await invoke<string>('git_rev_parse', { path: repoPath, reference: selectedBranch })
              const line = firstChangedLine(f.chunk)
              const url = await invoke<string>('gh_pr_inline_comment', {
                path: repoPath,
                prNumber: currentPrNumber,
                commitId,
                file: f.file,
                line,
                body,
              })
              inlineInput.value = ''
              showSentLink(inlineStatus, url)
              setTimeout(() => { inlineStatus.replaceChildren(); inlineForm.classList.add('hidden') }, 4000)
            } else {
              throw new Error('No PR found for this branch')
            }
          } catch (err) {
            inlineStatus.textContent = String(err)
            inlineStatus.className = 'review-comment-status review-comment-err'
          } finally {
            inlineSend.disabled = false
          }
        })

        details.append(sum, pre, inlineForm)
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
