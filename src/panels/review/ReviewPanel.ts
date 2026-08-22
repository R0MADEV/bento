import { invoke } from '@tauri-apps/api/core'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/icons'
import { parseDiffFiles } from '../diff/diffStats'
import { diffGit } from '../diff/diffGitClient'
import { reviewT } from './i18n'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import { getUiZoom, toLayoutPixels } from '../../ui/zoom'
import { redact, startAgent } from '../../core/ai/agentClient'
import { agentLabel, type AgentType } from '../../core/ai/config'
import { buildReviewPrompt, buildReviewSynthesisPrompt, buildReviewDocument, parseReviewCheckpoint, isRetryableReviewError, createContextProvider, type MultiAgentReviewRun } from '../../core/ai/techReview'
import { askAi } from '../../ui/askAi'
import { techReviewConversationKey, techReviewCheckpointKey } from '../../core/ai/chatHistory'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { t as i18nT } from '../../i18n'
import { buildReviewAgentControls } from './ReviewAgentControls'
import { buildReviewCommentBubble, buildReviewLineForm } from './ReviewCommentBubble'
import { buildReviewSidebarLists } from './ReviewSidebarLists'
import type { ReviewChangeFile, GhComment, GhPr, SidebarMode, FileTypeFilter } from './reviewFormat'
import {
  resolveReviewFollowUpSession,
  buildReviewFileManifest,
  buildReviewFileBatches,
  describeReviewPrState,
  describeReviewNoBranchChanges,
  filterReviewPrs,
  highlightCode,
  getFileState,
  computeCiStatus,
  relativeTime,
  wordDiff,
  esc,
} from './reviewFormat'

export {
  resolveReviewFollowUpSession,
  buildReviewFileManifest,
  buildReviewFileBatches,
  describeReviewPrState,
  describeReviewNoBranchChanges,
  filterReviewPrs,
}

const REPO_KEY = 'bento.review.repo'
const BASE_KEY = 'bento.review.base'

export function createReviewPanel(sessionPath?: string): { element: HTMLElement; dispose?: () => void; onVisibilityChange?: (visible: boolean) => void } {
  const root = document.createElement('div')
  root.className = 'review-panel'

  // Bug fix: use || so empty string from ctx.projectPath falls through to localStorage
  let repoPath: string = (sessionPath || localStorage.getItem(REPO_KEY)) ?? ''
  let baseBranch = localStorage.getItem(BASE_KEY) ?? ''
  let selectedBranch = ''
  let activeLocalBranch = ''
  let allBranches: string[] = []
  let currentPrNumber: number | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null
  let autoRefresh = false
  let panelVisible = true
  let existingComments: GhComment[] = []
  let loadingBranch = ''
  let sidebarMode: SidebarMode = 'branches'
  let openPrs: GhPr[] = []
  let fileTypeFilter: FileTypeFilter = 'all'
  let totalFiles = 0
  let commentNavIdx = -1
  let focusedFileIdx = -1
  let treeView = false
  let splitView = false
  let lastFiles: Array<ReturnType<typeof parseDiffFiles>[0] & { state: 'A'|'D'|'M' }> = []
  let lastStatusRollup: Array<{ name?: string; workflowName?: string; conclusion?: string|null; state?: string; context?: string; targetUrl?: string }> = []
  let resolvedComments: Set<number> = new Set()
  let discSeq = 0
  let prInfoSeq = 0
  let currentPrTitle = ''
  let currentPrBody = ''
  let currentPrState: string | null = null

  // ── Controls (mounted inside the collapsible sidebar below) ─────────────────
  const baseLabel = Object.assign(document.createElement('span'), { className: 'review-base-label', textContent: reviewT('baseBranch') })
  const branchWrap = document.createElement('div')
  branchWrap.className = 'review-branch-wrap'
  const branchInput = Object.assign(document.createElement('input'), {
    className: 'review-branch-input', type: 'text', value: baseBranch, placeholder: 'origin/main',
  })
  const branchDropdown = document.createElement('div')
  branchDropdown.className = 'review-branch-dropdown hidden'
  branchWrap.append(branchInput, branchDropdown)

  const mkIconBtn = (cls: string, title: string, ic: string): HTMLButtonElement =>
    Object.assign(document.createElement('button'), { className: `review-icon-btn ${cls}`.trim(), title, innerHTML: icon(ic) })

  const openBtn = mkIconBtn('', reviewT('openRepo'), 'folder')
  const refreshBtn = mkIconBtn('review-refresh-btn', reviewT('refresh'), 'refresh')
  const autoBtn = mkIconBtn('', reviewT('autoRefresh'), 'eye')
  const expandAllBtn = mkIconBtn('', reviewT('expandAll'), 'chevron-down')
  const collapseAllBtn = mkIconBtn('', reviewT('collapseAll'), 'chevron-up')
  const treeViewBtn = mkIconBtn('', reviewT('treeView'), 'list')
  const splitViewBtn = mkIconBtn('', 'Split view', 'diff')
  const copyDiffBtn = mkIconBtn('', reviewT('copyDiff'), 'copy')
  const aiReviewBtn = mkIconBtn('review-ai-btn', 'AI Review', 'star')
  // Re-open the last saved review for the selected branch (survives crash/reload).
  const reviewLastBtn = mkIconBtn('', 'Open last saved review', 'bookmark')

  const commentNavWrap = document.createElement('div')
  commentNavWrap.className = 'review-comment-nav hidden'
  const prevCommentBtn = mkIconBtn('', reviewT('prevComment'), 'arrow-left')
  const nextCommentBtn = mkIconBtn('', reviewT('nextComment'), 'arrow-right')
  commentNavWrap.append(prevCommentBtn, nextCommentBtn)

  const viewedCounterEl = Object.assign(document.createElement('span'), { className: 'review-viewed-counter hidden' })

  const {
    reviewAgentSelect,
    reviewCompareAgentsToggle,
    reviewCompareAgentsLabel,
    reviewAgentHint,
    reviewSecondaryRow,
    reviewTertiaryRow,
    reviewAgentBadge,
    selectedReviewAgents,
  } = buildReviewAgentControls()

  // ── Body: collapsible sidebar (all controls + lists) + free detail ──────────
  const body = document.createElement('div')
  body.className = 'review-body'

  const cs = createCollapsibleSidebar({
    storageKey: 'bento.review.sidebar',
    title: reviewT('title'),
    defaultWidth: 240,
    minWidth: 180,
    minRemaining: 420,
    container: body,
  })
  // Fixed controls/tabs on top, scrolling branch/PR list below.
  Object.assign(cs.list.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: '0' })

  // Header actions: open repo · refresh · auto-refresh · AI review.
  cs.actions.append(openBtn, refreshBtn, autoBtn, reviewLastBtn, aiReviewBtn, reviewAgentBadge)

  // Controls: base branch input + review agent selector.
  const controls = document.createElement('div')
  controls.className = 'review-controls'
  const baseRow = document.createElement('div')
  baseRow.className = 'review-base-row'
  baseRow.append(baseLabel, branchWrap)
  controls.append(baseRow, reviewAgentSelect, reviewCompareAgentsLabel, reviewAgentHint, reviewSecondaryRow, reviewTertiaryRow)

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
  cs.list.append(controls, sidebarTabs, branchSearch, branchList, prList)

  // Diff-view tools live in the sidebar footer so the detail stays free.
  const viewTools = document.createElement('div')
  viewTools.className = 'review-view-tools'
  viewTools.append(expandAllBtn, collapseAllBtn, treeViewBtn, splitViewBtn, copyDiffBtn, commentNavWrap, viewedCounterEl)
  cs.footer.append(viewTools)

  const detail = document.createElement('div')
  detail.className = 'review-detail'

  const diffSearchInput = Object.assign(document.createElement('input'), {
    className: 'review-diff-search hidden', type: 'search', placeholder: reviewT('searchDiff'),
  })
  const filterBar = document.createElement('div')
  filterBar.className = 'review-filter-bar hidden'
  const diffView = document.createElement('div')
  diffView.className = 'review-diff-view'

  const commentBar = document.createElement('div')
  commentBar.className = 'review-comment-bar hidden'

  const prMetaEl = document.createElement('div')
  prMetaEl.className = 'review-pr-meta'
  const prBodyEl = Object.assign(document.createElement('div'), { className: 'review-pr-body hidden' })
  const discussionEl = Object.assign(document.createElement('div'), { className: 'review-discussion hidden' })
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
  commentBar.append(prMetaEl, prBodyEl, discussionEl, commentInput, commentActionsRow)

  const reviewDrawer = document.createElement('aside')
  reviewDrawer.className = 'review-drawer hidden'
  const reviewDrawerHeader = document.createElement('div')
  reviewDrawerHeader.className = 'review-drawer-header'
  const reviewDrawerTitle = document.createElement('span')
  reviewDrawerTitle.className = 'review-drawer-title'
  reviewDrawerTitle.textContent = reviewT('title')
  const reviewDrawerMeta = document.createElement('span')
  reviewDrawerMeta.className = 'review-drawer-meta'
  const reviewDrawerActions = document.createElement('div')
  reviewDrawerActions.className = 'review-drawer-actions'
  const reviewDrawerCloseBtn = Object.assign(document.createElement('button'), { className: 'review-drawer-btn', textContent: i18nT('common.close') })
  reviewDrawerActions.append(reviewDrawerCloseBtn)
  reviewDrawerHeader.append(reviewDrawerTitle, reviewDrawerMeta, reviewDrawerActions)
  const reviewDrawerBody = document.createElement('div')
  reviewDrawerBody.className = 'review-drawer-body'
  reviewDrawer.append(reviewDrawerHeader, reviewDrawerBody)

  detail.append(diffSearchInput, filterBar, diffView, commentBar)
  body.append(cs.element, cs.resizer, detail)
  root.append(body, reviewDrawer)

  // ── Empty state ───────────────────────────────────────────────────────────
  const emptyState = document.createElement('div')
  emptyState.className = 'review-empty-state'
  const emptyOpenBtn = Object.assign(document.createElement('button'), { className: 'review-empty-open-btn', textContent: reviewT('openRepo') })
  emptyState.append(
    Object.assign(document.createElement('p'), { className: 'review-empty-title', textContent: reviewT('noRepo') }),
    Object.assign(document.createElement('p'), { className: 'review-empty-hint', textContent: reviewT('noRepoHint') }),
    emptyOpenBtn,
  )

  // Body is always visible — empty state shows inside diffView, never hides the panel

  // ── Helpers ───────────────────────────────────────────────────────────────
  const showNoRepo = (): void => { diffView.replaceChildren(emptyState) }

  const showSentLink = (el: HTMLElement, url: string): void => {
    el.replaceChildren()
    el.className = 'review-comment-status review-comment-ok'
    if (url) {
      const a = Object.assign(document.createElement('a'), { className: 'review-pr-link', textContent: reviewT('commentSent') + ' →', href: '#' })
      a.addEventListener('click', e => { e.preventDefault(); openUrl(url).catch(() => {}) })
      el.append(a)
    } else {
      el.textContent = reviewT('commentSent')
    }
  }

  const showReviewDrawer = (): void => {
    reviewDrawer.classList.remove('hidden')
    reviewDrawer.classList.add('visible')
  }

  const hideReviewDrawer = (): void => {
    reviewDrawer.classList.remove('visible')
    reviewDrawer.classList.add('hidden')
  }

  reviewDrawerCloseBtn.addEventListener('click', hideReviewDrawer)

  // Re-open the last saved review for the selected branch. Findings are
  // checkpointed to localStorage after each stage, so a crash or reload never
  // loses them — this restores the document (and re-wires its follow-up chat).
  const openSavedReview = (): void => {
    if (!repoPath || !selectedBranch) return
    const checkpoint = parseReviewCheckpoint(localStorage.getItem(techReviewCheckpointKey(repoPath, selectedBranch)))
    if (!checkpoint) {
      const note = Object.assign(document.createElement('div'), { className: 'review-error', textContent: 'No saved review for this branch yet' })
      diffView.prepend(note)
      note.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    reviewDrawerMeta.textContent = `${checkpoint.branch} · ${checkpoint.commit.slice(0, 7)}`
    reviewDrawerBody.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'review-drawer-result',
      innerHTML: renderMarkdown(checkpoint.content),
    }))
    showReviewDrawer()
    const projectName = repoPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? repoPath
    const followUpAgent = (checkpoint.sessionAgent ?? 'claude') as AgentType
    askAi('', false, undefined, undefined, { role: 'assistant', content: checkpoint.content }, repoPath, followUpAgent, techReviewConversationKey(repoPath, selectedBranch), `${projectName} · ${checkpoint.branch}`, checkpoint.branch, checkpoint.commit, checkpoint.sessionId ?? undefined, checkpoint.sessionAgent ?? undefined, [])
  }
  reviewLastBtn.addEventListener('click', openSavedReview)

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
    if (viewed) set.add(file); else set.delete(file)
    localStorage.setItem(viewedKey(), JSON.stringify([...set]))
    updateViewedCounter()
  }
  const updateViewedCounter = (): void => {
    if (totalFiles === 0) { viewedCounterEl.classList.add('hidden'); return }
    const done = getViewedFiles().size
    viewedCounterEl.textContent = reviewT('reviewedCount', { done, total: totalFiles })
    viewedCounterEl.classList.remove('hidden')
  }

  // ── Resolved comments ─────────────────────────────────────────────────────
  const resolvedKey = (): string => `bento.review.resolved.${repoPath}.${currentPrNumber ?? ''}`
  const getResolvedComments = (): Set<number> => {
    try { return new Set(JSON.parse(localStorage.getItem(resolvedKey()) ?? '[]') as number[]) }
    catch { return new Set() }
  }
  const setCommentResolved = (id: number, resolved: boolean): void => {
    const set = getResolvedComments()
    if (resolved) set.add(id); else set.delete(id)
    localStorage.setItem(resolvedKey(), JSON.stringify([...set]))
    resolvedComments = set
  }

  // ── Comment navigation ────────────────────────────────────────────────────
  const updateCommentNav = (): void => {
    commentNavWrap.classList.toggle('hidden', diffView.querySelectorAll('.review-existing-comment').length === 0)
    commentNavIdx = -1
  }
  const navigateComment = (dir: 1 | -1): void => {
    const comments = [...diffView.querySelectorAll<HTMLElement>('.review-existing-comment')]
    if (!comments.length) return
    commentNavIdx = (commentNavIdx + dir + comments.length) % comments.length
    comments[commentNavIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // ── File navigation ───────────────────────────────────────────────────────
  const navigateFile = (dir: 1 | -1): void => {
    const files = [...diffView.querySelectorAll<HTMLElement>('.review-file-detail:not(.hidden)')]
    if (!files.length) return
    files[focusedFileIdx]?.classList.remove('review-file-focused')
    focusedFileIdx = (focusedFileIdx + dir + files.length) % files.length
    files[focusedFileIdx]?.classList.add('review-file-focused')
    files[focusedFileIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const toggleCurrentViewed = (): void => {
    const files = [...diffView.querySelectorAll<HTMLElement>('.review-file-detail:not(.hidden)')]
    const el = files[focusedFileIdx]
    if (!el) return
    const cb = el.querySelector<HTMLInputElement>('.review-viewed-cb')
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')) }
  }
  const navigateUnviewed = (): void => {
    const viewedSet = getViewedFiles()
    const files = [...diffView.querySelectorAll<HTMLElement>('.review-file-detail:not(.hidden)')]
    const target = files.find(el => !viewedSet.has(el.dataset.filename ?? ''))
    if (!target) return
    files.forEach(f => f.classList.remove('review-file-focused'))
    focusedFileIdx = files.indexOf(target)
    target.classList.add('review-file-focused')
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const handleKeydown = (e: KeyboardEvent): void => {
    if (!root.isConnected) return
    const target = e.target as Element
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    switch (e.key) {
      case 'n': navigateComment(1); break
      case 'p': navigateComment(-1); break
      case 'j': navigateFile(1); break
      case 'k': navigateFile(-1); break
      case 'v': toggleCurrentViewed(); break
      case 'u': navigateUnviewed(); break
    }
  }
  document.addEventListener('keydown', handleKeydown)

  // ── CI checks popover ─────────────────────────────────────────────────────
  const showCiPopover = (anchor: HTMLElement): void => {
    root.querySelectorAll('.review-ci-popover').forEach(el => el.remove())
    if (!lastStatusRollup.length) return
    const popover = document.createElement('div')
    popover.className = 'review-ci-popover'
    popover.append(...lastStatusRollup.map(c => {
      const name = c.name ?? c.workflowName ?? c.context ?? 'Check'
      const val = (c.conclusion ?? c.state ?? '').toUpperCase()
      const ok = val === 'SUCCESS' || val === 'COMPLETED'
      const fail = ['FAILURE','ERROR','TIMED_OUT','CANCELLED'].includes(val)
      const item = document.createElement('div')
      item.className = 'review-ci-check'
      item.innerHTML = `<span class="review-ci-check-icon ${ok ? 'ci-ok' : fail ? 'ci-fail' : 'ci-pending'}">${ok ? '✓' : fail ? '✗' : '⟳'}</span><span class="review-ci-check-name">${esc(name)}</span>`
      if (c.targetUrl) {
        item.style.cursor = 'pointer'
        item.addEventListener('click', () => openUrl(c.targetUrl!).catch(() => {}))
      }
      return item
    }))
    const anchorRect = anchor.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const zoom = getUiZoom()
    popover.style.top = `${toLayoutPixels(anchorRect.bottom - rootRect.top, zoom) + 4}px`
    popover.style.left = `${toLayoutPixels(anchorRect.left - rootRect.left, zoom)}px`
    root.append(popover)
    const close = (e: MouseEvent): void => {
      if (!popover.contains(e.target as Node)) { popover.remove(); document.removeEventListener('click', close) }
    }
    setTimeout(() => document.addEventListener('click', close), 0)
  }

  // ── Comment bubble (edit/delete/reply) ────────────────────────────────────
  const commentActions = {
    repoPath: () => repoPath,
    isResolved: (id: number) => resolvedComments.has(id),
    setResolved: setCommentResolved,
    refresh: async () => { await loadExistingComments(); injectExistingComments() },
  }
  const buildCommentBubble = (c: GhComment): HTMLElement => buildReviewCommentBubble(c, commentActions)

  const { renderBranchList, renderPrList, loadPrList, setSidebarMode, renderBaseDropdown } = buildReviewSidebarLists(
    { branchSearch, branchList, prList, branchesTab, prsTab, branchInput, branchDropdown },
    {
      repoPath: () => repoPath,
      allBranches: () => allBranches,
      selectedBranch: () => selectedBranch,
      baseBranch: () => baseBranch,
      setBaseBranch: value => { baseBranch = value; localStorage.setItem(BASE_KEY, baseBranch) },
      sidebarMode: () => sidebarMode,
      setSidebarModeState: mode => { sidebarMode = mode },
      openPrs: () => openPrs,
      setOpenPrs: prs => { openPrs = prs },
      currentPrNumber: () => currentPrNumber,
      selectBranch: branch => selectBranch(branch),
      loadDiff: () => loadDiff(),
    },
  )

  const ghBranch = (b: string): string => b.replace(/^[^/]+\//, '')

  // ── Inline comment form (with draft) ─────────────────────────────────────
  const lineFormActions = {
    repoPath: () => repoPath,
    selectedBranch: () => selectedBranch,
    currentPrNumber: () => currentPrNumber,
    refresh: async () => { await loadExistingComments(); injectExistingComments() },
    showSentLink,
  }
  const makeLineForm = (filePath: string, line: number, startLine?: number): HTMLElement =>
    buildReviewLineForm(filePath, line, startLine, lineFormActions)

  // ── Diff renderer ─────────────────────────────────────────────────────────
  const buildFileDiff = (chunk: string, filePath: string): HTMLElement => {
    const container = document.createElement('div')
    container.dataset.filepath = filePath
    const ext = filePath.split('.').pop() ?? ''
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

    // Parse diff into typed entries for two-pass rendering with word diff
    type UEntry =
      | { kind: 'hunk'; raw: string }
      | { kind: 'meta' }
      | { kind: 'add'; lineNo: number; code: string }
      | { kind: 'del'; code: string }
      | { kind: 'ctx'; lineNo: number; code: string }

    const entries: UEntry[] = []
    let newLine = 0
    for (const raw of chunk.split('\n')) {
      const isAdd = raw.startsWith('+') && !raw.startsWith('+++')
      const isDel = raw.startsWith('-') && !raw.startsWith('---')
      const isHunk = raw.startsWith('@@')
      const isMeta = raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')
      if (isHunk) {
        const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
        if (m) newLine = parseInt(m[1], 10) - 1
        entries.push({ kind: 'hunk', raw })
      } else if (isMeta) {
        entries.push({ kind: 'meta' })
      } else if (isDel) {
        entries.push({ kind: 'del', code: raw.slice(1) })
      } else if (isAdd) {
        entries.push({ kind: 'add', lineNo: ++newLine, code: raw.slice(1) })
      } else {
        entries.push({ kind: 'ctx', lineNo: ++newLine, code: raw.slice(1) })
      }
    }

    const mkWrap = (lineNo: number | null, prefix: string, codeHtml: string, extraCls: string): HTMLElement => {
      const wrap = document.createElement('div')
      wrap.className = 'review-diff-line-wrap'
      const lineEl = document.createElement('div')
      lineEl.className = `tasks-diff-code-line${extraCls ? ' ' + extraCls : ''}`
      if (lineNo !== null) {
        wrap.dataset.line = String(lineNo)
        const capturedLine = lineNo
        const addBtn = Object.assign(document.createElement('button'), {
          className: 'review-line-comment-btn', textContent: '+', title: `Comment line ${lineNo}`,
        })
        addBtn.addEventListener('mousedown', e => {
          e.preventDefault(); dragStart = capturedLine
          highlightRange(capturedLine, capturedLine)
          document.addEventListener('mousemove', onMouseMove)
          document.addEventListener('mouseup', onMouseUp)
        })
        lineEl.append(addBtn)
      }
      const content = document.createElement('span')
      content.innerHTML = `<span class="tasks-diff-line-no">${lineNo ?? ''}</span>${esc(prefix)}${codeHtml}`
      lineEl.append(content); wrap.append(lineEl)
      return wrap
    }

    let i = 0
    while (i < entries.length) {
      const e = entries[i]
      if (e.kind === 'meta') { i++; continue }
      if (e.kind === 'hunk') {
        const hw = document.createElement('div'); hw.className = 'review-diff-line-wrap'
        const hl = document.createElement('div'); hl.className = 'tasks-diff-code-line tasks-diff-hunk'
        const hc = document.createElement('span')
        hc.innerHTML = `<span class="tasks-diff-line-no"></span>${esc(e.raw)}`
        hl.append(hc); hw.append(hl); container.append(hw)
        i++; continue
      }
      if (e.kind === 'ctx') {
        container.append(mkWrap(e.lineNo, ' ', highlightCode(e.code, ext), ''))
        i++; continue
      }
      // Collect consecutive del then add block, apply word diff for paired lines
      const dels: string[] = []
      while (i < entries.length && entries[i].kind === 'del') { dels.push((entries[i] as { kind: 'del'; code: string }).code); i++ }
      const adds: { lineNo: number; code: string }[] = []
      while (i < entries.length && entries[i].kind === 'add') { adds.push(entries[i] as { kind: 'add'; lineNo: number; code: string }); i++ }
      for (let j = 0; j < dels.length; j++) {
        const html = (adds[j] !== undefined) ? wordDiff(dels[j], adds[j].code).oldHtml : highlightCode(dels[j], ext)
        container.append(mkWrap(null, '-', html, 'tasks-diff-line-del'))
      }
      for (let j = 0; j < adds.length; j++) {
        const html = (dels[j] !== undefined) ? wordDiff(dels[j], adds[j].code).newHtml : highlightCode(adds[j].code, ext)
        container.append(mkWrap(adds[j].lineNo, '+', html, 'tasks-diff-line-add'))
      }
    }
    return container
  }

  // ── Side-by-side diff renderer ────────────────────────────────────────────
  const buildFileDiffSideBySide = (chunk: string, filePath: string): HTMLElement => {
    const container = document.createElement('div')
    container.className = 'review-split-diff'
    container.dataset.filepath = filePath
    const ext = filePath.split('.').pop() ?? ''

    type DiffEntry =
      | { kind: 'hunk'; text: string }
      | { kind: 'meta' }
      | { kind: 'context'; oldNo: number; newNo: number; text: string }
      | { kind: 'del'; oldNo: number; text: string }
      | { kind: 'add'; newNo: number; text: string }

    const entries: DiffEntry[] = []
    let oldLine = 0, newLine = 0

    for (const raw of chunk.split('\n')) {
      const isAdd = raw.startsWith('+') && !raw.startsWith('+++')
      const isDel = raw.startsWith('-') && !raw.startsWith('---')
      const isHunk = raw.startsWith('@@')
      const isMeta = raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')
      if (isHunk) {
        const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
        if (m) { oldLine = parseInt(m[1]) - 1; newLine = parseInt(m[2]) - 1 }
        entries.push({ kind: 'hunk', text: raw })
      } else if (isMeta) {
        entries.push({ kind: 'meta' })
      } else if (isDel) {
        entries.push({ kind: 'del', oldNo: ++oldLine, text: raw.slice(1) })
      } else if (isAdd) {
        entries.push({ kind: 'add', newNo: ++newLine, text: raw.slice(1) })
      } else {
        entries.push({ kind: 'context', oldNo: ++oldLine, newNo: ++newLine, text: raw })
      }
    }

    // Drag-to-select (right side only)
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
      const row = anchorWrap.closest('.review-split-row') ?? anchorWrap
      const form = makeLineForm(filePath, hi, lo < hi ? lo : undefined)
      row.after(form)
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

    const mkRightCell = (lineNo: number, text: string, extraCls: string, preHtml?: string): HTMLElement => {
      const cell = document.createElement('div')
      cell.className = `review-split-cell review-split-cell--right ${extraCls}`
      cell.dataset.line = String(lineNo)
      const addBtn = Object.assign(document.createElement('button'), {
        className: 'review-line-comment-btn', textContent: '+', title: `Comment line ${lineNo}`,
      })
      const cap = lineNo
      addBtn.addEventListener('mousedown', e => {
        e.preventDefault(); dragStart = cap
        highlightRange(cap, cap)
        document.addEventListener('mousemove', onMouseMove)
        document.addEventListener('mouseup', onMouseUp)
      })
      cell.innerHTML = `<span class="tasks-diff-line-no">${lineNo}</span>${preHtml ?? highlightCode(text, ext)}`
      cell.prepend(addBtn)
      return cell
    }

    let i = 0
    while (i < entries.length) {
      const entry = entries[i]
      if (entry.kind === 'meta') { i++; continue }
      if (entry.kind === 'hunk') {
        const hunkEl = Object.assign(document.createElement('div'), { className: 'review-split-hunk', textContent: entry.text })
        container.append(hunkEl); i++; continue
      }
      if (entry.kind === 'context') {
        const row = document.createElement('div')
        row.className = 'review-split-row'
        const left = document.createElement('div')
        left.className = 'review-split-cell review-split-cell--left'
        left.innerHTML = `<span class="tasks-diff-line-no">${entry.oldNo}</span>${highlightCode(entry.text, ext)}`
        row.append(left, mkRightCell(entry.newNo, entry.text, ''))
        container.append(row); i++; continue
      }
      // del/add block: collect and pair
      const dels: Array<{ kind: 'del'; oldNo: number; text: string }> = []
      const adds: Array<{ kind: 'add'; newNo: number; text: string }> = []
      while (i < entries.length && entries[i].kind === 'del') {
        dels.push(entries[i] as { kind: 'del'; oldNo: number; text: string }); i++
      }
      while (i < entries.length && entries[i].kind === 'add') {
        adds.push(entries[i] as { kind: 'add'; newNo: number; text: string }); i++
      }
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        const del = dels[j], add = adds[j]
        const wdiff = (del && add) ? wordDiff(del.text, add.text) : null
        const row = document.createElement('div')
        row.className = 'review-split-row'
        const left = document.createElement('div')
        if (del) {
          left.className = 'review-split-cell review-split-cell--left review-split-cell--del'
          left.innerHTML = `<span class="tasks-diff-line-no">${del.oldNo}</span>${wdiff ? wdiff.oldHtml : highlightCode(del.text, ext)}`
        } else {
          left.className = 'review-split-cell review-split-cell--left review-split-cell--empty'
        }
        const right = add
          ? mkRightCell(add.newNo, add.text, 'review-split-cell--add', wdiff?.newHtml)
          : Object.assign(document.createElement('div'), { className: 'review-split-cell review-split-cell--right review-split-cell--empty' })
        row.append(left, right)
        container.append(row)
      }
    }
    return container
  }

  // ── Build a file <details> element ────────────────────────────────────────
  const makeFileDetails = (f: typeof lastFiles[0]): HTMLDetailsElement => {
    const viewedSet = getViewedFiles()
    const details = document.createElement('details')
    details.className = 'review-file-detail'
    details.dataset.filestate = f.state
    details.dataset.filename = f.file
    details.open = lastFiles.length <= 5
    details.classList.toggle('review-file-viewed', viewedSet.has(f.file))

    const viewedCb = document.createElement('input')
    viewedCb.type = 'checkbox'; viewedCb.className = 'review-viewed-cb'
    viewedCb.checked = viewedSet.has(f.file); viewedCb.title = reviewT('viewed')
    viewedCb.addEventListener('click', e => e.stopPropagation())
    viewedCb.addEventListener('change', e => {
      e.stopPropagation()
      setFileViewed(f.file, viewedCb.checked)
      details.classList.toggle('review-file-viewed', viewedCb.checked)
      if (viewedCb.checked) details.open = false
    })

    const stateTag = Object.assign(document.createElement('span'), {
      className: `review-file-state review-file-state--${f.state.toLowerCase()}`, textContent: f.state,
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
      className: 'review-editor-btn review-icon-btn', title: reviewT('openInEditor'), innerHTML: icon('edit'),
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

    const fileCommentCount = existingComments.filter(c => c.path === f.file).length
    const commentBadge = Object.assign(document.createElement('span'), {
      className: `review-comment-badge${fileCommentCount === 0 ? ' hidden' : ''}`,
      textContent: fileCommentCount > 0 ? `💬 ${fileCommentCount}` : '',
      title: `${fileCommentCount} comment${fileCommentCount !== 1 ? 's' : ''}`,
    })
    commentBadge.addEventListener('click', e => {
      e.stopPropagation()
      details.open = true
      requestAnimationFrame(() => {
        const first = details.querySelector<HTMLElement>('.review-existing-comment')
        first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    })

    const fileCommentBtn = Object.assign(document.createElement('button'), {
      className: 'review-file-comment-btn', title: reviewT('fileComment'), textContent: '💬',
    })
    fileCommentBtn.addEventListener('click', e => {
      e.stopPropagation()
      if (details.querySelector('.review-file-comment-form')) return
      const form = document.createElement('div')
      form.className = 'review-file-comment-form'
      const ta = document.createElement('textarea')
      ta.className = 'review-comment-input'; ta.placeholder = reviewT('commentPlaceholder'); ta.rows = 2
      const acts = document.createElement('div'); acts.className = 'review-line-form-actions'
      const sendBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: reviewT('sendComment') })
      const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
      const st = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
      acts.append(cancelBtn, sendBtn, st); form.append(ta, acts)
      cancelBtn.addEventListener('click', () => form.remove())
      sendBtn.addEventListener('click', async () => {
        const body = ta.value.trim()
        if (!body || currentPrNumber === null) return
        sendBtn.disabled = true
        try {
          const url = await invoke<string>('gh_pr_comment', { path: repoPath, branch: prIdentifier(), body: `**${f.file}**\n\n${body}` })
          ta.value = ''; showSentLink(st, url)
          setTimeout(() => form.remove(), 4000)
        } catch (err) {
          st.textContent = String(err); st.className = 'review-comment-status review-comment-err'
        } finally { sendBtn.disabled = false }
      })
      sum.after(form); ta.focus()
    })

    const sum = document.createElement('summary')
    sum.className = 'review-file-summary'
    sum.append(viewedCb, stateTag, nameEl, commentBadge, editorBtn, fileCommentBtn, statsEl)
    details.append(sum, splitView ? buildFileDiffSideBySide(f.chunk, f.file) : buildFileDiff(f.chunk, f.file))
    return details
  }

  // ── Render files (flat or tree) ───────────────────────────────────────────
  const renderFiles = (): void => {
    focusedFileIdx = -1
    if (!treeView) {
      diffView.replaceChildren(...lastFiles.map(f => makeFileDetails(f)))
    } else {
      const dirs = new Map<string, typeof lastFiles>()
      for (const f of lastFiles) {
        const parts = f.file.split('/')
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
        const grp = dirs.get(dir) ?? []; grp.push(f); dirs.set(dir, grp)
      }
      const sorted = [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
      diffView.replaceChildren(...sorted.flatMap(([dir, files]) => {
        const nodes: HTMLElement[] = []
        if (dir) {
          nodes.push(Object.assign(document.createElement('div'), { className: 'review-tree-dir-name', textContent: dir + '/' }))
        }
        nodes.push(...files.map(f => makeFileDetails(f)))
        return nodes
      }))
    }
    applyVisibility()
    renderFilterBar()
  }

  // ── Search + filter visibility ────────────────────────────────────────────
  const applyVisibility = (): void => {
    const q = diffSearchInput.value.toLowerCase()
    const commentedPaths = new Set(existingComments.map(c => c.path))
    diffView.querySelectorAll<HTMLElement>('.review-file-detail').forEach(el => {
      const state = el.dataset.filestate ?? 'M'
      const filename = el.dataset.filename ?? ''
      const isCommentedFilter = fileTypeFilter === 'commented'
      const failsType = !isCommentedFilter && fileTypeFilter !== 'all' && state !== fileTypeFilter
      const failsCommented = isCommentedFilter && !commentedPaths.has(filename)
      const failsSearch = q !== '' && !filename.toLowerCase().includes(q)
      el.classList.toggle('hidden', failsType || failsCommented || failsSearch)
    })
  }

  diffSearchInput.addEventListener('input', applyVisibility)

  // ── Filter bar ────────────────────────────────────────────────────────────
  const renderFilterBar = (): void => {
    const counts = { A: 0, M: 0, D: 0 }
    lastFiles.forEach(f => { counts[f.state]++ })
    const total = lastFiles.length
    if (total === 0) { filterBar.classList.add('hidden'); return }
    filterBar.classList.remove('hidden')
    const mkBtn = (label: string, value: FileTypeFilter): HTMLButtonElement => {
      const btn = Object.assign(document.createElement('button'), {
        className: `review-filter-btn${fileTypeFilter === value ? ' review-filter-btn--active' : ''}`, textContent: label,
      })
      btn.addEventListener('click', () => {
        fileTypeFilter = value
        filterBar.querySelectorAll('.review-filter-btn').forEach(b => b.classList.remove('review-filter-btn--active'))
        btn.classList.add('review-filter-btn--active')
        applyVisibility()
      })
      return btn
    }
    const commentedPaths = new Set(existingComments.map(c => c.path))
    const commentedCount = lastFiles.filter(f => commentedPaths.has(f.file)).length
    if (fileTypeFilter === 'commented' && commentedCount === 0) fileTypeFilter = 'all'
    const filterBtns: HTMLButtonElement[] = [
      mkBtn(`All ${total}`, 'all'),
      mkBtn(`+${counts.A} Added`, 'A'),
      mkBtn(`~${counts.M} Modified`, 'M'),
      mkBtn(`−${counts.D} Deleted`, 'D'),
    ]
    if (commentedCount > 0) filterBtns.push(mkBtn(`💬 ${commentedCount}`, 'commented'))
    filterBar.replaceChildren(...filterBtns)
  }

  // ── Update comment badges on file headers ────────────────────────────────
  const updateCommentBadges = (): void => {
    diffView.querySelectorAll<HTMLElement>('.review-file-detail').forEach(el => {
      const filename = el.dataset.filename ?? ''
      const count = existingComments.filter(c => c.path === filename).length
      const badge = el.querySelector<HTMLElement>('.review-comment-badge')
      if (!badge) return
      if (count > 0) {
        badge.textContent = `💬 ${count}`
        badge.title = `${count} comment${count !== 1 ? 's' : ''}`
        badge.classList.remove('hidden')
      } else {
        badge.classList.add('hidden')
      }
    })
    renderFilterBar()
  }

  // ── Inject existing PR comments ───────────────────────────────────────────
  const injectExistingComments = (): void => {
    diffView.querySelectorAll('.review-existing-comment').forEach(el => el.remove())
    diffView.querySelectorAll('.review-comment-orphans').forEach(el => el.remove())
    const fileContainers = [...diffView.querySelectorAll<HTMLElement>('[data-filepath]')]
    const orphans = new Map<HTMLElement, GhComment[]>()

    for (const c of existingComments) {
      const fileContainer = fileContainers.find(el => el.dataset.filepath === c.path)
      if (!fileContainer) continue
      const lineWrap = fileContainer.querySelector<HTMLElement>(`[data-line="${c.line}"]`)
      if (lineWrap) {
        // Line is visible in the diff — inject inline
        const insertAnchor = lineWrap.closest('.review-split-row') ?? lineWrap
        insertAnchor.after(buildCommentBubble(c))
      } else {
        // Line not in diff context — collect as orphan to show at file bottom
        const list = orphans.get(fileContainer) ?? []
        list.push(c)
        orphans.set(fileContainer, list)
      }
    }

    // Append orphan comments at the bottom of their file diff
    for (const [container, comments] of orphans) {
      const section = document.createElement('div')
      section.className = 'review-comment-orphans'
      for (const c of comments) {
        const bubble = buildCommentBubble(c)
        const lineNote = Object.assign(document.createElement('div'), {
          className: 'review-orphan-line-note',
          textContent: `Line ${c.line} · ${c.path.split('/').pop()}`,
        })
        bubble.prepend(lineNote)
        section.append(bubble)
      }
      container.append(section)
    }

    updateCommentBadges()
    updateCommentNav()
  }

  const loadExistingComments = async (): Promise<void> => {
    if (currentPrNumber === null) { existingComments = []; return }
    try {
      const raw = await invoke<GhComment[]>('gh_pr_list_comments', { path: repoPath, prNumber: currentPrNumber })
      existingComments = raw.filter(c => c.line != null)
      resolvedComments = getResolvedComments()
    } catch { existingComments = [] }
  }

  // ── Load diff ─────────────────────────────────────────────────────────────
  const loadDiff = async (): Promise<void> => {
    filterBar.classList.add('hidden')
    diffSearchInput.classList.add('hidden')
    fileTypeFilter = 'all'
    diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }))
    try {
      let raw = selectedBranch === activeLocalBranch
        ? await diffGit.reviewWorktreeDiff(repoPath, baseBranch)
        : await invoke<string>('git_ref_diff', { path: repoPath, base: baseBranch, target: selectedBranch })
      if (!raw.trim() && currentPrState === 'MERGED' && currentPrNumber !== null) {
        const prDiff = await invoke<string>('gh_pr_diff_number', { path: repoPath, prNumber: currentPrNumber }).catch(() => '')
        if (prDiff.trim()) raw = prDiff
      }
      if (!raw.trim()) {
        totalFiles = 0; lastFiles = []; updateViewedCounter()
        diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: describeReviewNoBranchChanges(currentPrState, baseBranch) }))
        return
      }
      lastFiles = parseDiffFiles(raw).map(f => ({ ...f, state: getFileState(f.chunk) }))
      totalFiles = lastFiles.length
      updateViewedCounter()
      renderFiles()
      diffSearchInput.classList.remove('hidden')
    } catch (e) {
      diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-error', textContent: String(e) }))
    }
  }

  // ── Load PR info ──────────────────────────────────────────────────────────
  const loadPrInfo = async (): Promise<void> => {
    const myPrSeq = ++prInfoSeq
    currentPrNumber = null; existingComments = []; currentPrTitle = ''; currentPrBody = ''
    prMetaEl.replaceChildren(); prBodyEl.innerHTML = ''; prBodyEl.classList.add('hidden')
    discussionEl.replaceChildren(); discussionEl.classList.add('hidden')
    commentBar.classList.add('hidden')
    lastStatusRollup = []
    try {
      const pr = await invoke<{
        number: number; title: string; url: string; body: string; state?: string; mergedAt?: string | null
        statusCheckRollup: Array<{ name?: string; workflowName?: string; conclusion?: string | null; state?: string; context?: string; targetUrl?: string }>
        reviewDecision: string | null
      } | null>('gh_pr_view_branch', { path: repoPath, branch: ghBranch(selectedBranch) })
      if (prInfoSeq !== myPrSeq) return
      if (pr) {
        currentPrNumber = pr.number
        currentPrTitle = pr.title
        currentPrBody = pr.body ?? ''
        currentPrState = pr.state ?? null
        lastStatusRollup = pr.statusCheckRollup ?? []
        const link = Object.assign(document.createElement('a'), { className: 'review-pr-link', textContent: `PR #${pr.number}: ${pr.title}`, href: '#' })
        link.addEventListener('click', e => { e.preventDefault(); openUrl(pr.url).catch(() => {}) })
        prMetaEl.append(link)

        const stateBadge = describeReviewPrState(pr.state, pr.mergedAt)
        if (stateBadge) {
          prMetaEl.append(Object.assign(document.createElement('span'), {
            className: `review-pr-state ${stateBadge.cls}`,
            textContent: stateBadge.text,
            title: stateBadge.title,
          }))
        }

        const ci = computeCiStatus(lastStatusRollup)
        if (ci !== 'none') {
          const ciEl = Object.assign(document.createElement('span'), {
            className: `review-ci review-ci--${ci}`,
            textContent: ci === 'success' ? '✓ CI' : ci === 'failure' ? '✗ CI' : '⟳ CI',
          })
          ciEl.style.cursor = 'pointer'
          ciEl.addEventListener('click', e => { e.stopPropagation(); showCiPopover(ciEl) })
          prMetaEl.append(ciEl)
        }

        const decMap: Record<string, { text: string; cls: string }> = {
          APPROVED: { text: '✓ Approved', cls: 'review-decision--approved' },
          CHANGES_REQUESTED: { text: '✗ Changes requested', cls: 'review-decision--changes' },
          REVIEW_REQUIRED: { text: '? Review required', cls: 'review-decision--required' },
        }
        const dec = pr.reviewDecision ? decMap[pr.reviewDecision] : null
        if (dec) prMetaEl.append(Object.assign(document.createElement('span'), { className: `review-decision ${dec.cls}`, textContent: dec.text }))

        if (pr.body?.trim()) {
          prBodyEl.innerHTML = `<span class="review-pr-body-label">Description</span>${renderMarkdown(pr.body)}`
          prBodyEl.classList.remove('hidden')
        }
        commentBar.classList.remove('hidden')
        await loadExistingComments()

        // ── Discussion thread — loaded separately so a failure doesn't break PR info ──
        const myDiscSeq = ++discSeq
        invoke<{ comments: any[]; reviews: any[] }>('gh_pr_list_discussion', { path: repoPath, prNumber: pr.number })
          .then(disc => {
            if (discSeq !== myDiscSeq) return // newer loadPrInfo started
            type DiscItem = { author: string; body: string; time: string; decision?: { text: string; cls: string } }
            const discItems: DiscItem[] = [
              ...(disc.reviews ?? [])
                .filter((r: any) => r.body?.trim() && r.state !== 'PENDING')
                .map((r: any) => ({ author: r.user?.login ?? '?', body: r.body, time: r.submitted_at ?? '', decision: decMap[r.state] })),
              ...(disc.comments ?? [])
                .filter((c: any) => c.body?.trim())
                .map((c: any) => ({ author: c.user?.login ?? '?', body: c.body, time: c.created_at ?? '' })),
            ].sort((a, b) => a.time.localeCompare(b.time))
            if (discItems.length === 0) return
            const hdr = Object.assign(document.createElement('div'), {
              className: 'review-discussion-header',
              textContent: `Discussion · ${discItems.length}`,
            })
            discussionEl.replaceChildren(hdr, ...discItems.map(item => {
              const msg = document.createElement('div')
              msg.className = 'review-discussion-item'
              const meta = document.createElement('div')
              meta.className = 'review-discussion-meta'
              meta.append(Object.assign(document.createElement('span'), { className: 'review-comment-author', textContent: item.author }))
              if (item.decision) meta.append(Object.assign(document.createElement('span'), { className: `review-decision ${item.decision.cls} review-decision--sm`, textContent: item.decision.text }))
              if (item.time) meta.append(Object.assign(document.createElement('span'), { className: 'review-comment-time', textContent: relativeTime(item.time) }))
              const bodyDiv = Object.assign(document.createElement('div'), { className: 'review-discussion-body' })
              bodyDiv.innerHTML = renderMarkdown(item.body)
              msg.append(meta, bodyDiv)
              return msg
            }))
            discussionEl.classList.remove('hidden')
          })
          .catch(() => { /* discussion unavailable, PR info unaffected */ })

        if (sidebarMode === 'prs') renderPrList()
      }
    } catch { currentPrState = null }
  }

  const prIdentifier = (): string => currentPrNumber !== null ? String(currentPrNumber) : ghBranch(selectedBranch)

  // ── Select branch ─────────────────────────────────────────────────────────
  const selectBranch = async (branch: string): Promise<void> => {
    selectedBranch = branch; loadingBranch = branch
    renderBranchList()
    if (sidebarMode === 'prs') renderPrList()
    await Promise.all([loadDiff(), loadPrInfo()])
    if (loadingBranch === branch) injectExistingComments()
  }

  // ── Submit PR review (with summary confirm) ───────────────────────────────
  const submitReview = async (event: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> => {
    if (currentPrNumber === null) return
    const body = commentInput.value.trim()
    const viewed = getViewedFiles().size
    const key = event === 'APPROVE' ? 'approveConfirm' : 'requestChangesConfirm'
    const msg = reviewT(key, { number: currentPrNumber, viewed, total: totalFiles, comments: existingComments.length })
    if (!confirm(msg)) return
    approveBtn.disabled = true; requestChangesBtn.disabled = true
    try {
      await invoke<string>('gh_pr_submit_review', { path: repoPath, prNumber: currentPrNumber, event, body })
      commentInput.value = ''
      showCommentStatus(reviewT('reviewSubmitted'))
      await loadPrInfo()
      injectExistingComments()
    } catch (e) {
      showCommentStatus(String(e), true)
    } finally { approveBtn.disabled = false; requestChangesBtn.disabled = false }
  }

  // ── Event handlers ────────────────────────────────────────────────────────
  commentBtn.addEventListener('click', async () => {
    const body = commentInput.value.trim()
    if (!body) { commentInput.focus(); return }
    commentBtn.disabled = true
    try {
      const url = await invoke<string>('gh_pr_comment', { path: repoPath, branch: prIdentifier(), body })
      commentInput.value = ''; showSentLink(commentStatus, url)
    } catch (e) { showCommentStatus(String(e), true) }
    finally { commentBtn.disabled = false }
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
  treeViewBtn.addEventListener('click', () => {
    treeView = !treeView
    treeViewBtn.classList.toggle('review-icon-btn--active', treeView)
    treeViewBtn.title = treeView ? reviewT('listView') : reviewT('treeView')
    if (lastFiles.length) { renderFiles(); injectExistingComments() }
  })
  splitViewBtn.addEventListener('click', () => {
    splitView = !splitView
    splitViewBtn.classList.toggle('review-icon-btn--active', splitView)
    splitViewBtn.title = splitView ? 'Unified view' : 'Split view'
    if (lastFiles.length) { renderFiles(); injectExistingComments() }
  })
  copyDiffBtn.addEventListener('click', () => {
    if (!lastFiles.length) return
    const text = lastFiles.map(f => f.chunk).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      copyDiffBtn.title = '✓ Copied!'
      setTimeout(() => { copyDiffBtn.title = reviewT('copyDiff') }, 2000)
    }).catch(() => {})
  })

  // ── Load branches ─────────────────────────────────────────────────────────
  const loadBranches = async (): Promise<void> => {
    if (!repoPath) return
    const [defaultBranch, branches, currentBranch] = await Promise.all([
      diffGit.defaultBranch(repoPath),
      diffGit.reviewBranches(repoPath),
      diffGit.currentBranch(repoPath),
    ])
    allBranches = currentBranch
      ? [currentBranch, ...branches.filter(branch => branch !== currentBranch)]
      : branches
    activeLocalBranch = currentBranch
    if (!baseBranch) {
      const originDefault = `origin/${defaultBranch}`
      baseBranch = allBranches.includes(originDefault) ? originDefault : defaultBranch
      branchInput.value = baseBranch
      localStorage.setItem(BASE_KEY, baseBranch)
    }
    renderBranchList()
    loadPrList()
    if (!selectedBranch && currentBranch && currentBranch !== defaultBranch) {
      void selectBranch(currentBranch)
    }
  }

  const setAutoRefresh = (on: boolean): void => {
    autoRefresh = on
    autoBtn.classList.toggle('review-icon-btn--active', on)
    if (intervalId) { clearInterval(intervalId); intervalId = null }
    if (on && panelVisible) intervalId = setInterval(() => { if (selectedBranch) loadDiff() }, 5000)
  }

  const pickRepo = async (): Promise<void> => {
    const picked = await pickFolder({ directory: true, multiple: false }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked; baseBranch = ''; branchInput.value = ''
    selectedBranch = ''; activeLocalBranch = ''; existingComments = []; totalFiles = 0
    fileTypeFilter = 'all'; openPrs = []; lastFiles = []; lastStatusRollup = []
    localStorage.setItem(REPO_KEY, repoPath)
    diffView.replaceChildren(); filterBar.classList.add('hidden')
    diffSearchInput.classList.add('hidden'); prBodyEl.classList.add('hidden')
    commentBar.classList.add('hidden'); viewedCounterEl.classList.add('hidden')
    commentNavWrap.classList.add('hidden')
    await loadBranches()
  }

  openBtn.addEventListener('click', pickRepo)
  emptyOpenBtn.addEventListener('click', pickRepo)
  refreshBtn.addEventListener('click', () => { loadBranches(); if (selectedBranch) loadDiff() })
  autoBtn.addEventListener('click', () => setAutoRefresh(!autoRefresh))

  // Optional author context typed before a review (what the branch does / what to
  // focus on). Persisted per branch and injected into the review prompt.
  const reviewContextKey = (): string => `bento.review.context:${repoPath}:${selectedBranch}`
  let pendingReviewContext: string | null = null
  const showReviewContextForm = (): void => {
    const form = document.createElement('div')
    form.className = 'review-context-form'
    const label = Object.assign(document.createElement('label'), { className: 'review-context-label', textContent: 'Contexto para la review (opcional): ¿qué hace esta rama y en qué fijarse?' })
    const ta = Object.assign(document.createElement('textarea'), {
      className: 'review-context-input',
      value: (() => { try { return localStorage.getItem(reviewContextKey()) ?? '' } catch { return '' } })(),
      placeholder: 'Ej: añade tests de contrato de la API; comprueba que no rompa el refactor de la BD…',
    })
    const runBtn = Object.assign(document.createElement('button'), { className: 'review-context-run', textContent: 'Revisar' })
    runBtn.addEventListener('click', () => {
      const value = ta.value.trim()
      try { if (value) localStorage.setItem(reviewContextKey(), value); else localStorage.removeItem(reviewContextKey()) } catch { /* storage full */ }
      pendingReviewContext = value
      aiReviewBtn.click()
    })
    const actions = Object.assign(document.createElement('div'), { className: 'review-context-actions' })
    actions.append(runBtn)
    form.append(label, ta, actions)
    reviewDrawerMeta.textContent = ''
    reviewDrawerBody.replaceChildren(form)
    showReviewDrawer()
    ta.focus()
  }

  aiReviewBtn.addEventListener('click', async () => {
    const showReviewError = (message: string): void => {
      console.error('[AI Review]', message)
      const error = Object.assign(document.createElement('div'), { className: 'review-error', textContent: message })
      if (reviewDrawer.classList.contains('visible')) {
        reviewDrawerBody.replaceChildren(error)
        error.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
      diffView.prepend(error)
      error.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    if (!repoPath) { showReviewError('Open a repository first'); return }
    if (!selectedBranch) { showReviewError('Select a branch first'); return }
    if (!lastFiles.length) { showReviewError('There are no changes to review'); return }
    const reviewAgents = selectedReviewAgents()
    if (reviewCompareAgentsToggle.checked && reviewAgents.length < 2) {
      showReviewError(i18nT('common.reviewSelectAnotherAgent'))
      return
    }
    // First click shows the optional context form; its "Revisar" re-triggers this
    // with the context set. Reset after reading so the next review asks again.
    if (pendingReviewContext === null) { showReviewContextForm(); return }
    const reviewContext = pendingReviewContext
    pendingReviewContext = null
    const reviewRepoPath = repoPath
    const reviewBranch = selectedBranch
    const reviewBaseBranch = baseBranch
    const reviewAgent = reviewAgents.at(-1) ?? reviewAgents[0]
    const reviewConversationKey = techReviewConversationKey(reviewRepoPath, reviewBranch)
    const reviewProjectName = reviewRepoPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? reviewRepoPath
    const prLine = currentPrNumber ? `PR #${currentPrNumber}: ${currentPrTitle}` : `Branch: ${reviewBranch}`
    const descSection = currentPrBody.trim() ? `\nDescription:\n${currentPrBody.trim()}\n` : ''
    const authorContext = reviewContext.trim() ? `\nContexto del autor (qué hace la rama / en qué fijarse):\n${reviewContext.trim()}\n` : ''
    const reviewFileManifest = buildReviewFileManifest(lastFiles)
    const reviewOverview = `${prLine}\nBase: ${reviewBaseBranch} <- ${reviewBranch}\n${descSection}${authorContext}Files:\n${reviewFileManifest}\n\nReview the files in the current batch first. If a file is not included below, read it directly from the worktree before deciding.`
    const reviewChangedFiles = lastFiles.map(file => file.file)
    aiReviewBtn.disabled = true
    aiReviewBtn.title = 'Reviewing...'
    const reviewEvidence: string[] = []

    // Progress box visible desde el principio
    const progressBox = document.createElement('div')
    progressBox.className = 'review-ai-progress'
    const progressHeader = document.createElement('div')
    progressHeader.className = 'review-ai-progress-header'
    const progressStatus = Object.assign(document.createElement('span'), { className: 'review-ai-progress-status', textContent: 'Preparing review…' })
    const progressMeta = Object.assign(document.createElement('span'), { className: 'review-ai-progress-meta' })
    const stopReviewBtn = Object.assign(document.createElement('button'), {
      className: 'review-ai-stop-btn',
      textContent: 'Stop',
      disabled: true,
    })
    const progressStream = Object.assign(document.createElement('pre'), { className: 'review-ai-progress-stream' })
    const progressToggleBtn = mkIconBtn('review-ai-toggle-btn', 'Ocultar/mostrar la salida del agente', 'chevron-up')
    progressToggleBtn.addEventListener('click', () => {
      const collapsed = progressStream.classList.toggle('collapsed')
      progressToggleBtn.innerHTML = icon(collapsed ? 'chevron-down' : 'chevron-up')
    })
    progressHeader.append(progressStatus, progressMeta, progressToggleBtn, stopReviewBtn)
    progressBox.append(progressHeader, progressStream)
    reviewDrawerMeta.textContent = ''
    reviewDrawerBody.replaceChildren(progressBox)
    showReviewDrawer()
    progressBox.scrollIntoView({ block: 'start', behavior: 'smooth' })

    const startedAt = Date.now()
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000)
      const chars = progressStream.textContent?.length ?? 0
      progressMeta.textContent = chars ? `${chars} chars · ${secs}s` : `${secs}s`
    }, 500)
    // Agents run in parallel, so track every in-flight handle (not just one) to
    // cancel them all on Stop.
    const activeReviewHandles = new Set<ReturnType<typeof startAgent>>()
    let reviewStopped = false
    stopReviewBtn.addEventListener('click', async () => {
      if (reviewStopped || !activeReviewHandles.size) return
      reviewStopped = true
      stopReviewBtn.disabled = true
      progressStatus.textContent = 'Stopping review…'
      await Promise.all([...activeReviewHandles].map(handle => handle.cancel().catch(() => {})))
    })

    const showResult = (content: string, reviewCommit: string, followUpSession: { sessionId: string | null; sessionAgent: AgentType | null }): void => {
      reviewDrawerMeta.textContent = `${reviewBranch} · ${reviewCommit.slice(0, 7)}`
      reviewDrawerBody.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'review-drawer-result',
        innerHTML: renderMarkdown(content),
      }))
      showReviewDrawer()
      const followUpAgent = followUpSession.sessionAgent ?? reviewAgent
      askAi('', false, undefined, undefined, { role: 'assistant', content }, reviewRepoPath, followUpAgent, reviewConversationKey, `${reviewProjectName} · ${reviewBranch}`, reviewBranch, reviewCommit, followUpSession.sessionId ?? undefined, followUpSession.sessionAgent ?? undefined, reviewEvidence)
    }
    let worktree = ''
    let managedWorktree = false
    let reviewCommit = ''
    // Declared outside the try so the catch can salvage whatever completed.
    const reviewRuns: MultiAgentReviewRun[] = []
    // In-flight batches of the current agent, used to salvage a crash that
    // happens before any consolidated run lands in reviewRuns.
    let lastBatchRuns: MultiAgentReviewRun[] = []
    const reviewMeta = () => ({
      branch: reviewBranch,
      base: reviewBaseBranch,
      commit: reviewCommit,
      compareAgents: reviewCompareAgentsToggle.checked,
      fallbackAgentLabel: agentLabel(reviewAgent),
    })
    const outputRuns = (): MultiAgentReviewRun[] => (reviewRuns.length ? reviewRuns : lastBatchRuns)
    // Persist the document after every stage so a crash/reload never loses findings.
    const saveReviewCheckpoint = (): void => {
      const runs = outputRuns().filter(run => run.report || run.error)
      if (!runs.length || !reviewCommit) return
      const followUpSession = resolveReviewFollowUpSession(runs, runs.length)
      try {
        localStorage.setItem(techReviewCheckpointKey(reviewRepoPath, reviewBranch), JSON.stringify({
          content: buildReviewDocument(reviewMeta(), runs),
          commit: reviewCommit,
          branch: reviewBranch,
          sessionId: followUpSession.sessionId ?? null,
          sessionAgent: followUpSession.sessionAgent ?? null,
        }))
      } catch { /* storage full — the on-screen salvage still applies */ }
    }
    try {
      progressStatus.textContent = 'Creating isolated worktree…'
      const branchContext = await invoke<{ path: string; commit: string; managed: boolean }>('review_branch_context_prepare', {
        repoPath: reviewRepoPath,
        reference: reviewBranch,
        commit: null,
      })
      worktree = branchContext.path
      managedWorktree = branchContext.managed
      reviewCommit = branchContext.commit
      const snapshotBefore = await invoke<string>('review_snapshot', { repoPath: worktree })
      progressStatus.textContent = 'Gathering context…'
      const contextProvider = createContextProvider({
        lexis: async () => {
          const content = await invoke<string>('review_lexis_context', {
            path: worktree,
            question: [
              `Build a compact review bundle for: ${reviewChangedFiles.join(', ')}`,
              'Return impact, callers, definitions, tests, risks and likely blast radius.',
              'Prefer structured evidence over prose.',
            ].join(' '),
          })
          if (!content) throw new Error('Lexis returned no context')
          return [{ path: '<lexis>', content, reason: 'reference' as const }]
        },
        direct: async () => lastFiles.map(file => ({ path: file.file, content: file.chunk, reason: 'changed' as const })),
      })
      const context = await contextProvider.collect({ repoRoot: worktree, diff: reviewOverview, changedFiles: reviewChangedFiles })
      const sharedPrompt = buildReviewPrompt({
        diff: reviewOverview,
        files: [],
        contextSources: context.sources,
        lexisContext: context.snippets.filter(snippet => snippet.reason !== 'changed').map(snippet => `${snippet.path}\n${snippet.content}`).join('\n\n'),
      })
      // One full-change prompt per agent: the whole diff + as much file content as
      // fits inline (large files truncated; the agent reads the rest via its tools).
      const ONE_PASS_CONTENT_BUDGET = 150_000
      const perFileBudget = Math.max(800, Math.floor(ONE_PASS_CONTENT_BUDGET / Math.max(lastFiles.length, 1)))
      const onePassPrompt = buildReviewPrompt({
        diff: reviewOverview,
        files: lastFiles.map(file => ({
          path: file.file,
          content: file.chunk.length > perFileBudget
            ? `${file.chunk.slice(0, perFileBudget)}\n[truncado; lee el resto en el worktree]`
            : file.chunk,
        })),
        contextSources: context.sources,
        lexisContext: context.snippets.filter(snippet => snippet.reason !== 'changed').map(snippet => `${snippet.path}\n${snippet.content}`).join('\n\n'),
      })
      const snapshotBeforeAgent = await invoke<string>('review_snapshot', { repoPath: worktree })
      if (snapshotBeforeAgent !== snapshotBefore) throw new Error('Repository changed while preparing the review')
      const MAX_REVIEW_ATTEMPTS = 2
      const runReviewAgent = async (agent: AgentType, prompt: string, kind: 'analysis' | 'verification' = 'analysis'): Promise<MultiAgentReviewRun> => {
        const label = agentLabel(agent)
        const run: MultiAgentReviewRun = { label, agent }
        const stageLabel = kind === 'verification' ? 'Síntesis final' : 'Análisis'
        // A transient blip (rate limit, network, generic exit) used to kill the
        // stage; retry it once. Timeouts are NOT retried (see isRetryableReviewError).
        for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
          if (reviewStopped) break
          run.error = undefined
          run.report = undefined
          let output = ''
          const handle = startAgent(
            { agent, message: prompt, history: [], projectPath: worktree, review: true },
            chunk => {
              output += chunk
              // Show the full process (bounded), and keep it pinned to the bottom.
              progressStream.textContent = output.length > 40_000 ? '…' + output.slice(-40_000) : output
              progressStream.scrollTop = progressStream.scrollHeight
            },
            sessionId => { run.sessionId = sessionId },
            message => { run.error = message },
            tool => {
              const safeTool = redact(tool).slice(0, 1_000)
              if (!reviewEvidence.includes(safeTool)) reviewEvidence.push(safeTool)
              progressStatus.textContent = `${label} · ${stageLabel}: ${safeTool}`
            },
          )
          activeReviewHandles.add(handle)
          stopReviewBtn.disabled = false
          try {
            await handle.ready
            // `completed` resolves right after the done/error callback has already
            // run synchronously, so run.error / run.sessionId are set by this point.
            await handle.completed
            if (!run.error && !reviewStopped) {
              const report = output.trim()
              if (!report) throw new Error('El agente no devolvió ningún análisis')
              run.report = report
            }
          } catch (error) {
            run.error = error instanceof Error ? error.message : String(error)
          } finally {
            handle.unlisten()
            activeReviewHandles.delete(handle)
            if (!activeReviewHandles.size) stopReviewBtn.disabled = true
          }
          const shouldRetry = attempt < MAX_REVIEW_ATTEMPTS && !reviewStopped && !run.report && !!run.error && isRetryableReviewError(run.error)
          if (!shouldRetry) break
          await new Promise<void>(resolve => setTimeout(resolve, 3_000 * attempt))
        }
        return run
      }

      // Each agent does ONE full-change analysis (reading files itself), all in
      // parallel. The final verifier then consolidates: the multi-agent pipeline is
      // kept; only the per-agent file batching (that made it take hours) is gone.
      progressStatus.textContent = `Revisando con ${reviewAgents.length} agente(s) en paralelo…`
      const agentRuns = await Promise.all(reviewAgents.map(agent => runReviewAgent(agent, onePassPrompt, 'analysis')))
      lastBatchRuns = agentRuns
      reviewRuns.push(...agentRuns.filter(run => run.report || run.error))
      saveReviewCheckpoint()

      // With ≥2 agents, one of them consolidates everyone's analysis into a final
      // report (the pipeline: each agent analyses, the last one synthesizes).
      const reportsToSynthesize = reviewRuns.filter(run => run.report).map(run => ({ label: run.label, report: run.report as string }))
      if (!reviewStopped && reportsToSynthesize.length >= 2) {
        progressStatus.textContent = 'Síntesis final…'
        const verifierAgent = reviewAgents.at(-1) ?? reviewAgents[0]
        const synthesisPrompt = buildReviewSynthesisPrompt(sharedPrompt, reportsToSynthesize)
        const synthesisRun = await runReviewAgent(verifierAgent, synthesisPrompt, 'verification')
        synthesisRun.label = 'Síntesis final'
        reviewRuns.push(synthesisRun)
        saveReviewCheckpoint()
      }

      if (reviewStopped) throw new Error('Review stopped')
      const successfulRuns = reviewRuns.filter(run => run.report)
      if (!successfulRuns.length) throw new Error('No valid review responses')

      const snapshotAfter = await invoke<string>('review_snapshot', { repoPath: worktree })
      const content = buildReviewDocument(reviewMeta(), reviewRuns)
      const followUpSession = resolveReviewFollowUpSession(reviewRuns, reviewRuns.length)
      saveReviewCheckpoint()
      showResult(content, reviewCommit, followUpSession)
      if (snapshotAfter !== snapshotBefore) showReviewError('Repository changed during review; findings may be stale')
    } catch (error) {
      // Never discard completed findings on failure/stop: render + persist what
      // we have and show the error as a note, instead of wiping the drawer.
      const salvaged = outputRuns().filter(run => run.report)
      if (salvaged.length) {
        saveReviewCheckpoint()
        showResult(buildReviewDocument(reviewMeta(), salvaged), reviewCommit, resolveReviewFollowUpSession(salvaged, salvaged.length))
        const note = Object.assign(document.createElement('div'), { className: 'review-error', textContent: `Review incompleto (se guardó lo revisado): ${String(error)}` })
        reviewDrawerBody.prepend(note)
        note.scrollIntoView({ block: 'start', behavior: 'smooth' })
      } else {
        reviewDrawerBody.replaceChildren(); showReviewDrawer(); showReviewError(String(error))
      }
    }
      finally {
        clearInterval(timer)
        if (!reviewStopped) reviewDrawerMeta.textContent = reviewDrawerMeta.textContent || reviewT('title')
        if (managedWorktree) {
          await invoke('review_branch_context_release', { path: worktree }).catch(error => showReviewError(String(error)))
        }
        aiReviewBtn.disabled = false
        aiReviewBtn.title = 'AI Review'
      }
  })

  // ── Init ──────────────────────────────────────────────────────────────────
  if (repoPath) {
    diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: reviewT('selectBranch') }))
    loadBranches()
  } else {
    showNoRepo()
  }

  return {
    element: root,
    dispose: () => {
      if (intervalId) clearInterval(intervalId)
      document.removeEventListener('keydown', handleKeydown)
    },
    onVisibilityChange: (visible: boolean) => {
      panelVisible = visible
      if (!visible && intervalId) { clearInterval(intervalId); intervalId = null }
      else if (visible && autoRefresh && !intervalId) intervalId = setInterval(() => { if (selectedBranch) loadDiff() }, 5000)
    },
  }
}
