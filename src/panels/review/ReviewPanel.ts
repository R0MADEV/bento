import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/helpers/icons'
import { reviewT } from './i18n'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import { getUiZoom, toLayoutPixels } from '../../ui/helpers/zoom'
import type { AgentType } from '../../core/ai/config'
import { loadReviewCheckpoint } from './reviewCheckpoints'
import { askAi } from '../../ui/askAi'
import { techReviewConversationKey, techReviewCheckpointKey } from '../../core/ai/chatHistory'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { t as i18nT } from '../../i18n'
import { buildReviewAgentControls } from './ReviewAgentControls'
import { buildReviewCommentBubble, buildReviewLineForm } from './ReviewCommentBubble'
import { buildReviewSidebarLists } from './ReviewSidebarLists'
import { buildReviewDiffView } from './ReviewDiffView'
import { buildReviewDataLoader } from './reviewDataLoader'
import { buildReviewAiRun } from './reviewAiRun'
import type { GhComment, GhPr, SidebarMode, FileTypeFilter, ReviewChangeFile } from './reviewFormat'
import {
  resolveReviewFollowUpSession,
  buildReviewFileManifest,
  buildReviewFileBatches,
  describeReviewPrState,
  describeReviewNoBranchChanges,
  filterReviewPrs,
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
  let lastFiles: ReviewChangeFile[] = []
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
  // checkpointed after each stage, so a crash or reload never loses them —
  // this restores the document (and re-wires its follow-up chat).
  const openSavedReview = async (): Promise<void> => {
    if (!repoPath || !selectedBranch) return
    const checkpoint = await loadReviewCheckpoint(repoPath, selectedBranch, localStorage.getItem(techReviewCheckpointKey(repoPath, selectedBranch)))
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
  reviewLastBtn.addEventListener('click', () => { openSavedReview() })

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
    currentPrNumber: () => currentPrNumber,
    isResolved: (id: number) => resolvedComments.has(id),
    setResolved: setCommentResolved,
    refresh: async () => { await loadExistingComments(); injectExistingComments() },
  }
  const buildCommentBubble = (c: GhComment): HTMLElement => buildReviewCommentBubble(c, commentActions)

  const { renderBranchList, renderPrList, loadPrList } = buildReviewSidebarLists(
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

  const { renderFiles, injectExistingComments } = buildReviewDiffView(
    { diffView, diffSearchInput, filterBar },
    {
      getLastFiles: () => lastFiles,
      getTreeView: () => treeView,
      getSplitView: () => splitView,
      getExistingComments: () => existingComments,
      getFileTypeFilter: () => fileTypeFilter,
      setFileTypeFilter: value => { fileTypeFilter = value },
      resetFocusedFileIdx: () => { focusedFileIdx = -1 },
      getViewedFiles,
      setFileViewed,
      repoPath: () => repoPath,
      getCurrentPrNumber: () => currentPrNumber,
      getPrIdentifier: () => prIdentifier(),
      buildCommentBubble,
      makeLineForm,
      updateCommentNav,
      showSentLink,
    },
  )

  const { loadDiff, loadExistingComments, selectBranch, submitReview, loadBranches, pickRepo, prIdentifier } = buildReviewDataLoader(
    { filterBar, diffSearchInput, diffView, prMetaEl, prBodyEl, discussionEl, commentBar, branchInput, viewedCounterEl, commentNavWrap, commentInput, approveBtn, requestChangesBtn },
    {
      getRepoPath: () => repoPath,
      setRepoPath: v => { repoPath = v },
      getBaseBranch: () => baseBranch,
      setBaseBranch: v => { baseBranch = v },
      getSelectedBranch: () => selectedBranch,
      setSelectedBranch: v => { selectedBranch = v },
      getActiveLocalBranch: () => activeLocalBranch,
      setActiveLocalBranch: v => { activeLocalBranch = v },
      setAllBranches: v => { allBranches = v },
      getCurrentPrNumber: () => currentPrNumber,
      setCurrentPrNumber: v => { currentPrNumber = v },
      getExistingComments: () => existingComments,
      setExistingComments: v => { existingComments = v },
      getLoadingBranch: () => loadingBranch,
      setLoadingBranch: v => { loadingBranch = v },
      getSidebarMode: () => sidebarMode,
      setOpenPrs: v => { openPrs = v },
      setFileTypeFilter: v => { fileTypeFilter = v },
      getTotalFiles: () => totalFiles,
      setTotalFiles: v => { totalFiles = v },
      setLastFiles: v => { lastFiles = v },
      setLastStatusRollup: v => { lastStatusRollup = v },
      setResolvedComments: v => { resolvedComments = v },
      getResolvedComments,
      nextDiscSeq: () => ++discSeq,
      getDiscSeq: () => discSeq,
      nextPrInfoSeq: () => ++prInfoSeq,
      getPrInfoSeq: () => prInfoSeq,
      setCurrentPrTitle: v => { currentPrTitle = v },
      setCurrentPrBody: v => { currentPrBody = v },
      getCurrentPrState: () => currentPrState,
      setCurrentPrState: v => { currentPrState = v },
      getViewedFiles,
      renderBranchList,
      renderPrList,
      loadPrList,
      renderFiles,
      injectExistingComments,
      updateViewedCounter,
      showCommentStatus,
      showCiPopover,
    },
  )

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

  const setAutoRefresh = (on: boolean): void => {
    autoRefresh = on
    autoBtn.classList.toggle('review-icon-btn--active', on)
    if (intervalId) { clearInterval(intervalId); intervalId = null }
    if (on && panelVisible) intervalId = setInterval(() => { if (selectedBranch) loadDiff() }, 5000)
  }

  openBtn.addEventListener('click', pickRepo)
  emptyOpenBtn.addEventListener('click', pickRepo)
  refreshBtn.addEventListener('click', () => { loadBranches(); if (selectedBranch) loadDiff() })
  autoBtn.addEventListener('click', () => setAutoRefresh(!autoRefresh))

  const { handleAiReviewClick } = buildReviewAiRun(
    { aiReviewBtn, reviewCompareAgentsToggle, reviewDrawer, reviewDrawerMeta, reviewDrawerBody, diffView },
    {
      getRepoPath: () => repoPath,
      getSelectedBranch: () => selectedBranch,
      getBaseBranch: () => baseBranch,
      getLastFiles: () => lastFiles,
      getCurrentPrNumber: () => currentPrNumber,
      getCurrentPrTitle: () => currentPrTitle,
      getCurrentPrBody: () => currentPrBody,
      selectedReviewAgents,
      showReviewDrawer,
      mkIconBtn,
    },
  )
  aiReviewBtn.addEventListener('click', handleAiReviewClick)

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
