import { invoke } from '@tauri-apps/api/core'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/icons'
import { parseDiffFiles } from '../diff/diffStats'
import { diffGit } from '../diff/diffGitClient'
import { reviewT } from './i18n'

const REPO_KEY = 'bento.review.repo'
const BASE_KEY = 'bento.review.base'

interface GhComment {
  path: string
  line: number
  body: string
  user: { login: string }
  html_url: string
}

interface GhPr {
  number: number
  title: string
  url: string
  headRefName: string
  author: { login: string }
}

type SidebarMode = 'branches' | 'prs'
type FileTypeFilter = 'all' | 'A' | 'M' | 'D'

const getFileState = (chunk: string): 'A' | 'D' | 'M' => {
  if (/^new file mode/m.test(chunk)) return 'A'
  if (/^deleted file mode/m.test(chunk)) return 'D'
  return 'M'
}

const computeCiStatus = (rollup: Array<{ conclusion?: string | null; state?: string }>): 'success' | 'failure' | 'pending' | 'none' => {
  if (!rollup?.length) return 'none'
  const vals = rollup.map(c => (c.conclusion ?? c.state ?? '').toUpperCase())
  if (vals.some(v => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(v))) return 'failure'
  if (vals.some(v => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'ACTION_REQUIRED'].includes(v))) return 'pending'
  return 'success'
}

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
  let existingComments: GhComment[] = []
  let loadingBranch = ''
  let sidebarMode: SidebarMode = 'branches'
  let openPrs: GhPr[] = []
  let fileTypeFilter: FileTypeFilter = 'all'
  let totalFiles = 0
  let commentNavIdx = -1

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div')
  toolbar.className = 'review-toolbar'

  const baseLabel = Object.assign(document.createElement('span'), {
    className: 'review-base-label', textContent: reviewT('baseBranch'),
  })
  const branchWrap = document.createElement('div')
  branchWrap.className = 'review-branch-wrap'
  const branchInput = Object.assign(document.createElement('input'), {
    className: 'review-branch-input', type: 'text', value: baseBranch, placeholder: 'origin/main',
  })
  const branchDropdown = document.createElement('div')
  branchDropdown.className = 'review-branch-dropdown hidden'
  branchWrap.append(branchInput, branchDropdown)

  const openBtn = Object.assign(document.createElement('button'), { className: 'review-icon-btn', title: reviewT('openRepo'), innerHTML: icon('folder') })
  const refreshBtn = Object.assign(document.createElement('button'), { className: 'review-refresh-btn review-icon-btn', title: reviewT('refresh'), innerHTML: icon('refresh') })
  const autoBtn = Object.assign(document.createElement('button'), { className: 'review-icon-btn', title: reviewT('autoRefresh'), innerHTML: icon('eye') })
  const expandAllBtn = Object.assign(document.createElement('button'), { className: 'review-icon-btn', title: reviewT('expandAll'), innerHTML: icon('chevron-down') })
  const collapseAllBtn = Object.assign(document.createElement('button'), { className: 'review-icon-btn', title: reviewT('collapseAll'), innerHTML: icon('chevron-up') })

  const commentNavWrap = document.createElement('div')
  commentNavWrap.className = 'review-comment-nav hidden'
  const prevCommentBtn = Object.assign(document.createElement('button'), { className: 'review-icon-btn', title: reviewT('prevComment'), innerHTML: icon('arrow-left') })
  const nextCommentBtn = Object.assign(document.createElement('button'), { className: 'review-icon-btn', title: reviewT('nextComment'), innerHTML: icon('arrow-right') })
  commentNavWrap.append(prevCommentBtn, nextCommentBtn)

  const viewedCounterEl = Object.assign(document.createElement('span'), { className: 'review-viewed-counter hidden' })

  toolbar.append(baseLabel, branchWrap, openBtn, refreshBtn, autoBtn, expandAllBtn, collapseAllBtn, commentNavWrap, viewedCounterEl)

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.className = 'review-body'

  const sidebar = document.createElement('div')
  sidebar.className = 'review-sidebar'

  const sidebarTabs = document.createElement('div')
  sidebarTabs.className = 'review-sidebar-tabs'
  const branchesTab = Object.assign(document.createElement('button'), { className: 'review-tab review-tab--active', textContent: reviewT('branches') })
  const prsTab = Object.assign(document.createElement('button'), { className: 'review-tab', textContent: reviewT('pullRequests') })
  sidebarTabs.append(branchesTab, prsTab)

  const branchSearch = Object.assign(document.createElement('input'), {
    className: 'review-branch-search', type: 'text', placeholder: 'Filter…',
  })
  const branchList = document.createElement('div')
  branchList.className = 'review-branch-list'
  const prList = document.createElement('div')
  prList.className = 'review-pr-list hidden'
  sidebar.append(sidebarTabs, branchSearch, branchList, prList)

  const detail = document.createElement('div')
  detail.className = 'review-detail'

  const filterBar = document.createElement('div')
  filterBar.className = 'review-filter-bar hidden'

  const diffView = document.createElement('div')
  diffView.className = 'review-diff-view'

  const commentBar = document.createElement('div')
  commentBar.className = 'review-comment-bar hidden'

  const prMetaEl = document.createElement('div')
  prMetaEl.className = 'review-pr-meta'
  const prBodyEl = Object.assign(document.createElement('div'), { className: 'review-pr-body hidden' })
  const commentInput = document.createElement('textarea')
  commentInput.className = 'review-comment-input'
  commentInput.placeholder = reviewT('commentPlaceholder')
  commentInput.rows = 3

  const commentActionsRow = document.createElement('div')
  commentActionsRow.className = 'review-comment-actions'
  const commentBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: reviewT('sendComment') })
  const approveBtn = Object.assign(document.createElement('button'), { className: 'review-approve-btn', textContent: reviewT('approve') })
  const requestChangesBtn = Object.assign(document.createElement('button'), { className: 'review-request-changes-btn', textContent: reviewT('requestChanges') })
  const commentStatus = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
  commentActionsRow.append(commentBtn, approveBtn, requestChangesBtn, commentStatus)
  commentBar.append(prMetaEl, prBodyEl, commentInput, commentActionsRow)

  detail.append(filterBar, diffView, commentBar)
  body.append(sidebar, detail)

  // ── Empty state ───────────────────────────────────────────────────────────
  const emptyState = document.createElement('div')
  emptyState.className = 'review-empty-state'
  const emptyOpenBtn = Object.assign(document.createElement('button'), { className: 'review-empty-open-btn', textContent: reviewT('openRepo') })
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
        className: 'review-pr-link', textContent: reviewT('commentSent') + ' →', href: '#',
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

  // ── Viewed files ──────────────────────────────────────────────────────────
  const viewedKey = (): string => `bento.review.viewed.${repoPath}.${selectedBranch}`
  const getViewedFiles = (): Set<string> => {
    try { return new Set(JSON.parse(localStorage.getItem(viewedKey()) ?? '[]') as string[]) }
    catch { return new Set() }
  }
  const setFileViewed = (file: string, viewed: boolean): void => {
    const set = getViewedFiles()
    viewed ? set.add(file) : set.delete(file)
    localStorage.setItem(viewedKey(), JSON.stringify([...set]))
    updateViewedCounter()
  }
  const updateViewedCounter = (): void => {
    if (totalFiles === 0) { viewedCounterEl.classList.add('hidden'); return }
    const done = getViewedFiles().size
    viewedCounterEl.textContent = reviewT('reviewedCount', { done, total: totalFiles })
    viewedCounterEl.classList.remove('hidden')
  }

  // ── Comment navigation ────────────────────────────────────────────────────
  const updateCommentNav = (): void => {
    const count = diffView.querySelectorAll('.review-existing-comment').length
    commentNavWrap.classList.toggle('hidden', count === 0)
    commentNavIdx = -1
  }
  const navigateComment = (dir: 1 | -1): void => {
    const comments = [...diffView.querySelectorAll<HTMLElement>('.review-existing-comment')]
    if (!comments.length) return
    commentNavIdx = (commentNavIdx + dir + comments.length) % comments.length
    comments[commentNavIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // ── Sidebar: branches ─────────────────────────────────────────────────────
  const renderBranchList = (): void => {
    const q = branchSearch.value.toLowerCase()
    const visible = q ? allBranches.filter(b => b.toLowerCase().includes(q)) : allBranches
    branchList.replaceChildren(...visible.slice(0, 50).map(b => {
      const item = Object.assign(document.createElement('div'), {
        className: `review-branch-item${b === selectedBranch ? ' review-branch-item--active' : ''}`,
        textContent: b, title: b,
      })
      item.addEventListener('click', () => { selectBranch(b) })
      return item
    }))
  }

  branchSearch.addEventListener('input', renderBranchList)

  // ── Sidebar: PR list ──────────────────────────────────────────────────────
  const renderPrList = (): void => {
    if (!openPrs.length) {
      prList.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'review-pr-list-empty', textContent: reviewT('noPrs') }),
      )
      return
    }
    prList.replaceChildren(...openPrs.map(pr => {
      const item = document.createElement('div')
      item.className = `review-pr-item${currentPrNumber === pr.number ? ' review-pr-item--active' : ''}`
      item.append(
        Object.assign(document.createElement('div'), { className: 'review-pr-item-title', textContent: `#${pr.number} ${pr.title}` }),
        Object.assign(document.createElement('div'), { className: 'review-pr-item-author', textContent: pr.author.login }),
      )
      item.addEventListener('click', () => {
        const branch = allBranches.find(b => b.endsWith('/' + pr.headRefName)) ?? ('origin/' + pr.headRefName)
        selectBranch(branch)
      })
      return item
    }))
  }

  const loadPrList = async (): Promise<void> => {
    if (!repoPath) return
    try {
      openPrs = await invoke<GhPr[]>('gh_pr_list_open', { path: repoPath })
      if (sidebarMode === 'prs') renderPrList()
    } catch { openPrs = [] }
  }

  const setSidebarMode = (mode: SidebarMode): void => {
    sidebarMode = mode
    branchesTab.classList.toggle('review-tab--active', mode === 'branches')
    prsTab.classList.toggle('review-tab--active', mode === 'prs')
    branchList.classList.toggle('hidden', mode === 'prs')
    prList.classList.toggle('hidden', mode === 'branches')
    branchSearch.classList.toggle('hidden', mode === 'prs')
    if (mode === 'prs') {
      renderPrList()
      if (!openPrs.length) loadPrList()
    }
  }

  branchesTab.addEventListener('click', () => setSidebarMode('branches'))
  prsTab.addEventListener('click', () => setSidebarMode('prs'))

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
        baseBranch = b; branchInput.value = b
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

  const ghBranch = (b: string): string => b.replace(/^[^/]+\//, '')

  // ── Inline comment form ───────────────────────────────────────────────────
  const makeLineForm = (filePath: string, line: number, startLine?: number): HTMLElement => {
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
        const url = await invoke<string>('gh_pr_inline_comment', {
          path: repoPath, prNumber: currentPrNumber, commitId, file: filePath, line, startLine, body,
        })
        input.value = ''
        showSentLink(status, url)
        // Refresh so the new comment appears immediately as a bubble
        await loadExistingComments()
        injectExistingComments()
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

  // ── Diff renderer ─────────────────────────────────────────────────────────
  const buildFileDiff = (chunk: string, filePath: string): HTMLElement => {
    const container = document.createElement('div')
    container.dataset.filepath = filePath
    let newLine = 0
    let dragStart: number | null = null

    const lineFromEl = (el: Element | null): number | null => {
      const wrap = el?.closest<HTMLElement>('[data-line]')
      const n = parseInt(wrap?.dataset.line ?? '', 10)
      return isNaN(n) ? null : n
    }

    const clearHighlight = (): void =>
      container.querySelectorAll('.review-line-wrap--selected').forEach(el => el.classList.remove('review-line-wrap--selected'))

    const highlightRange = (a: number, b: number): void => {
      const lo = Math.min(a, b), hi = Math.max(a, b)
      container.querySelectorAll<HTMLElement>('[data-line]').forEach(wrap => {
        const ln = parseInt(wrap.dataset.line ?? '', 10)
        wrap.classList.toggle('review-line-wrap--selected', ln >= lo && ln <= hi)
      })
    }

    const openRangeForm = (lo: number, hi: number): void => {
      container.querySelectorAll('.review-line-form').forEach(el => el.remove())
      clearHighlight()
      const anchorWrap = container.querySelector<HTMLElement>(`[data-line="${hi}"]`)
      if (!anchorWrap) return
      const form = makeLineForm(filePath, hi, lo < hi ? lo : undefined)
      anchorWrap.after(form)
      form.querySelector('textarea')?.focus()
    }

    const onMouseMove = (e: MouseEvent): void => {
      if (dragStart === null) return
      const ln = lineFromEl(document.elementFromPoint(e.clientX, e.clientY))
      if (ln !== null) highlightRange(dragStart, ln)
    }

    const onMouseUp = (e: MouseEvent): void => {
      if (dragStart === null) return
      const ln = lineFromEl(document.elementFromPoint(e.clientX, e.clientY)) ?? dragStart
      const lo = Math.min(dragStart, ln), hi = Math.max(dragStart, ln)
      dragStart = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      openRangeForm(lo, hi)
    }

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
        wrap.dataset.line = String(fileLine)
        const capturedLine = fileLine
        const addBtn = Object.assign(document.createElement('button'), {
          className: 'review-line-comment-btn', textContent: '+', title: `Comment line ${fileLine}`,
        })
        addBtn.addEventListener('mousedown', e => {
          e.preventDefault()
          dragStart = capturedLine
          highlightRange(capturedLine, capturedLine)
          document.addEventListener('mousemove', onMouseMove)
          document.addEventListener('mouseup', onMouseUp)
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

  // ── Filter bar ────────────────────────────────────────────────────────────
  const applyFilter = (): void => {
    diffView.querySelectorAll<HTMLElement>('.review-file-detail').forEach(el => {
      const state = el.dataset.filestate ?? 'M'
      el.classList.toggle('hidden', fileTypeFilter !== 'all' && state !== fileTypeFilter)
    })
  }

  const renderFilterBar = (counts: { A: number; M: number; D: number }): void => {
    filterBar.replaceChildren()
    const total = counts.A + counts.M + counts.D
    if (total === 0) { filterBar.classList.add('hidden'); return }
    filterBar.classList.remove('hidden')
    const makeBtn = (label: string, value: FileTypeFilter): HTMLButtonElement => {
      const btn = Object.assign(document.createElement('button'), {
        className: `review-filter-btn${fileTypeFilter === value ? ' review-filter-btn--active' : ''}`,
        textContent: label,
      })
      btn.addEventListener('click', () => {
        fileTypeFilter = value
        filterBar.querySelectorAll('.review-filter-btn').forEach(b => b.classList.remove('review-filter-btn--active'))
        btn.classList.add('review-filter-btn--active')
        applyFilter()
      })
      return btn
    }
    filterBar.append(
      makeBtn(`All ${total}`, 'all'),
      makeBtn(`+${counts.A} Added`, 'A'),
      makeBtn(`~${counts.M} Modified`, 'M'),
      makeBtn(`−${counts.D} Deleted`, 'D'),
    )
  }

  // ── Inject existing PR comments ───────────────────────────────────────────
  const injectExistingComments = (): void => {
    diffView.querySelectorAll('.review-existing-comment').forEach(el => el.remove())
    const fileContainers = [...diffView.querySelectorAll<HTMLElement>('[data-filepath]')]
    for (const c of existingComments) {
      const fileContainer = fileContainers.find(el => el.dataset.filepath === c.path)
      if (!fileContainer) continue
      const lineWrap = fileContainer.querySelector<HTMLElement>(`[data-line="${c.line}"]`)
      if (!lineWrap) continue
      const bubble = document.createElement('div')
      bubble.className = 'review-existing-comment'
      bubble.append(
        Object.assign(document.createElement('div'), { className: 'review-existing-comment-header', textContent: c.user.login }),
        Object.assign(document.createElement('div'), { className: 'review-existing-comment-body', textContent: c.body }),
      )
      lineWrap.after(bubble)
    }
    updateCommentNav()
  }

  // ── Load PR inline comments ───────────────────────────────────────────────
  const loadExistingComments = async (): Promise<void> => {
    if (currentPrNumber === null) { existingComments = []; return }
    try {
      const raw = await invoke<GhComment[]>('gh_pr_list_comments', { path: repoPath, prNumber: currentPrNumber })
      existingComments = raw.filter(c => c.line != null)
    } catch { existingComments = [] }
  }

  // ── Load diff ─────────────────────────────────────────────────────────────
  const loadDiff = async (): Promise<void> => {
    filterBar.classList.add('hidden')
    fileTypeFilter = 'all'
    diffView.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }),
    )
    try {
      const raw = await invoke<string>('git_ref_diff', { path: repoPath, base: baseBranch, target: selectedBranch })
      if (!raw.trim()) {
        totalFiles = 0
        updateViewedCounter()
        diffView.replaceChildren(
          Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: reviewT('noBranchChanges', { base: baseBranch }) }),
        )
        return
      }
      const files = parseDiffFiles(raw)
      totalFiles = files.length
      updateViewedCounter()
      const counts = { A: 0, M: 0, D: 0 }
      const viewedSet = getViewedFiles()

      diffView.replaceChildren(...files.map(f => {
        const state = getFileState(f.chunk)
        counts[state]++

        const details = document.createElement('details')
        details.className = 'review-file-detail'
        details.dataset.filestate = state
        details.open = files.length <= 5
        details.classList.toggle('review-file-viewed', viewedSet.has(f.file))

        const viewedCb = document.createElement('input')
        viewedCb.type = 'checkbox'
        viewedCb.className = 'review-viewed-cb'
        viewedCb.checked = viewedSet.has(f.file)
        viewedCb.title = reviewT('viewed')
        viewedCb.addEventListener('click', e => e.stopPropagation())
        viewedCb.addEventListener('change', e => {
          e.stopPropagation()
          setFileViewed(f.file, viewedCb.checked)
          details.classList.toggle('review-file-viewed', viewedCb.checked)
          if (viewedCb.checked) details.open = false
        })

        const stateTag = Object.assign(document.createElement('span'), {
          className: `review-file-state review-file-state--${state.toLowerCase()}`,
          textContent: state,
        })

        const nameEl = Object.assign(document.createElement('span'), {
          className: 'review-file-name', textContent: f.file, title: reviewT('copyPath'),
        })
        nameEl.addEventListener('click', e => {
          e.stopPropagation()
          navigator.clipboard.writeText(f.file).then(() => {
            nameEl.textContent = '✓ copied'
            setTimeout(() => { nameEl.textContent = f.file }, 1500)
          }).catch(() => {})
        })

        const editorBtn = Object.assign(document.createElement('button'), {
          className: 'review-editor-btn review-icon-btn',
          title: reviewT('openInEditor'),
          innerHTML: icon('edit'),
        })
        editorBtn.addEventListener('click', e => {
          e.stopPropagation()
          invoke('open_in_editor', { path: `${repoPath}/${f.file}` }).catch(() => {})
        })

        const statsEl = document.createElement('span')
        statsEl.className = 'review-file-stats'
        statsEl.append(
          Object.assign(document.createElement('span'), { className: 'review-stat-add', textContent: `+${f.additions}` }),
          Object.assign(document.createElement('span'), { className: 'review-stat-del', textContent: `-${f.deletions}` }),
        )

        const sum = document.createElement('summary')
        sum.className = 'review-file-summary'
        sum.append(viewedCb, stateTag, nameEl, editorBtn, statsEl)

        details.append(sum, buildFileDiff(f.chunk, f.file))
        return details
      }))

      renderFilterBar(counts)
    } catch (e) {
      diffView.replaceChildren(
        Object.assign(document.createElement('div'), { className: 'review-error', textContent: String(e) }),
      )
    }
  }

  // ── Load PR info ──────────────────────────────────────────────────────────
  const loadPrInfo = async (): Promise<void> => {
    currentPrNumber = null
    existingComments = []
    prMetaEl.replaceChildren()
    prBodyEl.classList.add('hidden')
    commentBar.classList.add('hidden')
    try {
      const pr = await invoke<{
        number: number; title: string; url: string; body: string
        statusCheckRollup: Array<{ conclusion?: string | null; state?: string }>
        reviewDecision: string | null
      } | null>('gh_pr_view_branch', { path: repoPath, branch: ghBranch(selectedBranch) })
      if (pr) {
        currentPrNumber = pr.number
        const link = Object.assign(document.createElement('a'), {
          className: 'review-pr-link', textContent: `PR #${pr.number}: ${pr.title}`, href: '#',
        })
        link.addEventListener('click', e => { e.preventDefault(); openUrl(pr.url).catch(() => {}) })
        prMetaEl.append(link)

        const ci = computeCiStatus(pr.statusCheckRollup ?? [])
        if (ci !== 'none') {
          prMetaEl.append(Object.assign(document.createElement('span'), {
            className: `review-ci review-ci--${ci}`,
            textContent: ci === 'success' ? '✓ CI' : ci === 'failure' ? '✗ CI' : '⟳ CI',
          }))
        }

        const decMap: Record<string, { text: string; cls: string }> = {
          APPROVED: { text: '✓ Approved', cls: 'review-decision--approved' },
          CHANGES_REQUESTED: { text: '✗ Changes requested', cls: 'review-decision--changes' },
          REVIEW_REQUIRED: { text: '? Review required', cls: 'review-decision--required' },
        }
        const dec = pr.reviewDecision ? decMap[pr.reviewDecision] : null
        if (dec) {
          prMetaEl.append(Object.assign(document.createElement('span'), {
            className: `review-decision ${dec.cls}`, textContent: dec.text,
          }))
        }

        if (pr.body?.trim()) {
          prBodyEl.textContent = pr.body
          prBodyEl.classList.remove('hidden')
        }
        commentBar.classList.remove('hidden')
        await loadExistingComments()
        if (sidebarMode === 'prs') renderPrList()
      }
    } catch { /* no PR */ }
  }

  const prIdentifier = (): string =>
    currentPrNumber !== null ? String(currentPrNumber) : ghBranch(selectedBranch)

  // ── Select branch ─────────────────────────────────────────────────────────
  const selectBranch = async (branch: string): Promise<void> => {
    selectedBranch = branch
    loadingBranch = branch
    renderBranchList()
    if (sidebarMode === 'prs') renderPrList()
    await Promise.all([loadDiff(), loadPrInfo()])
    if (loadingBranch === branch) injectExistingComments()
  }

  // ── Submit PR review ──────────────────────────────────────────────────────
  const submitReview = async (event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> => {
    if (currentPrNumber === null) return
    const body = commentInput.value.trim()
    approveBtn.disabled = true; requestChangesBtn.disabled = true
    try {
      await invoke<string>('gh_pr_submit_review', { path: repoPath, prNumber: currentPrNumber, event, body })
      commentInput.value = ''
      showCommentStatus(reviewT('reviewSubmitted'))
      await loadPrInfo()
      injectExistingComments()
    } catch (e) {
      showCommentStatus(String(e), true)
    } finally {
      approveBtn.disabled = false; requestChangesBtn.disabled = false
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────────
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

  approveBtn.addEventListener('click', () => { submitReview('APPROVE') })
  requestChangesBtn.addEventListener('click', () => { submitReview('REQUEST_CHANGES') })
  expandAllBtn.addEventListener('click', () =>
    diffView.querySelectorAll<HTMLDetailsElement>('.review-file-detail').forEach(d => { d.open = true })
  )
  collapseAllBtn.addEventListener('click', () =>
    diffView.querySelectorAll<HTMLDetailsElement>('.review-file-detail').forEach(d => { d.open = false })
  )
  prevCommentBtn.addEventListener('click', () => navigateComment(-1))
  nextCommentBtn.addEventListener('click', () => navigateComment(1))

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
    loadPrList()
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
    baseBranch = ''; branchInput.value = ''
    selectedBranch = ''; existingComments = []
    totalFiles = 0; fileTypeFilter = 'all'; openPrs = []
    localStorage.setItem(REPO_KEY, repoPath)
    setEmptyVisible(false)
    diffView.replaceChildren()
    filterBar.classList.add('hidden')
    prBodyEl.classList.add('hidden')
    commentBar.classList.add('hidden')
    viewedCounterEl.classList.add('hidden')
    commentNavWrap.classList.add('hidden')
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
