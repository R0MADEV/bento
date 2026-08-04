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
import { buildReviewPrompt, createContextProvider, validateReviewResponse, type ReviewResponse } from '../../core/ai/techReview'
import { askAi } from '../../ui/askAi'
import { techReviewConversationKey } from '../../core/ai/chatHistory'

const REPO_KEY = 'bento.review.repo'
const BASE_KEY = 'bento.review.base'

interface GhComment {
  id: number
  path: string
  line: number
  body: string
  user: { login: string }
  html_url: string
  created_at?: string
}

interface GhPr {
  number: number
  title: string
  url: string
  headRefName: string
  baseRefName: string
  author: { login: string }
}

type SidebarMode = 'branches' | 'prs'
type FileTypeFilter = 'all' | 'A' | 'M' | 'D' | 'commented'

// ── Syntax highlighting ───────────────────────────────────────────────────────
const KW: Record<string, string[]> = {
  ts: ['const','let','var','function','return','if','else','for','while','class','import','export','from','default','async','await','new','this','typeof','null','undefined','true','false','void','type','interface','enum','extends','implements','public','private','protected','readonly','static','abstract','switch','case','break','continue','try','catch','finally','throw','delete','in','of','instanceof'],
  rs: ['fn','let','mut','const','struct','enum','impl','trait','use','pub','mod','return','if','else','for','while','match','Some','None','Ok','Err','true','false','self','Self','super','crate','async','await','move','where','type','ref','loop','break','continue'],
  py: ['def','class','return','if','else','elif','for','while','import','from','as','with','in','not','and','or','is','None','True','False','pass','break','continue','try','except','finally','raise','yield','async','await','lambda','global','nonlocal'],
  go: ['func','var','const','return','if','else','for','range','go','select','case','default','break','continue','type','struct','interface','import','package','nil','true','false','defer','make','new','len','cap','chan','map','switch'],
  css: ['@import','@media','@keyframes','@font-face','!important'],
}
const EXT_LANG: Record<string, string> = {
  ts:'ts', tsx:'ts', js:'ts', jsx:'ts', mjs:'ts', cjs:'ts',
  rs:'rs', py:'py', go:'go', css:'css', scss:'css',
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sp = (cls: string, text: string): string => `<span class="sh-${cls}">${esc(text)}</span>`

function highlightCode(code: string, ext: string): string {
  const lang = EXT_LANG[ext.toLowerCase()]
  if (!lang) return esc(code)
  const kws = new Set(KW[lang] ?? [])
  const commentPfx = lang === 'py' ? '#' : '//'
  const result: string[] = []
  let i = 0
  while (i < code.length) {
    if (code.startsWith(commentPfx, i)) { result.push(sp('comment', code.slice(i))); break }
    if (lang !== 'py' && code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2)
      const s = end === -1 ? code.slice(i) : code.slice(i, end + 2)
      result.push(sp('comment', s)); i += s.length; continue
    }
    const q = code[i]
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === q) { j++; break }
        j++
      }
      result.push(sp('string', code.slice(i, j))); i = j; continue
    }
    if (code[i] >= '0' && code[i] <= '9') {
      let j = i
      while (j < code.length && /[\d._a-zA-Z]/.test(code[j])) j++
      result.push(sp('number', code.slice(i, j))); i = j; continue
    }
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i
      while (j < code.length && /[\w$]/.test(code[j])) j++
      const word = code.slice(i, j)
      result.push(kws.has(word) ? sp('keyword', word) : esc(word)); i = j; continue
    }
    result.push(esc(code[i])); i++
  }
  return result.join('')
}

// ── File state from diff chunk ────────────────────────────────────────────────
const getFileState = (chunk: string): 'A' | 'D' | 'M' => {
  if (/^new file mode/m.test(chunk)) return 'A'
  if (/^deleted file mode/m.test(chunk)) return 'D'
  return 'M'
}

// ── CI status ─────────────────────────────────────────────────────────────────
const computeCiStatus = (rollup: Array<{ conclusion?: string | null; state?: string }>): 'success' | 'failure' | 'pending' | 'none' => {
  if (!rollup?.length) return 'none'
  const vals = rollup.map(c => (c.conclusion ?? c.state ?? '').toUpperCase())
  if (vals.some(v => ['FAILURE','ERROR','TIMED_OUT','CANCELLED'].includes(v))) return 'failure'
  if (vals.some(v => ['PENDING','IN_PROGRESS','QUEUED','WAITING','ACTION_REQUIRED'].includes(v))) return 'pending'
  return 'success'
}

// ── Relative time ─────────────────────────────────────────────────────────────
const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'just now'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// ── Word-level diff ───────────────────────────────────────────────────────────
const wordDiff = (oldText: string, newText: string): { oldHtml: string; newHtml: string } => {
  const tokenize = (s: string): string[] => {
    const r: string[] = []
    let i = 0
    while (i < s.length) {
      if (/\w/.test(s[i])) {
        let j = i; while (j < s.length && /\w/.test(s[j])) j++
        r.push(s.slice(i, j)); i = j
      } else { r.push(s[i]); i++ }
    }
    return r
  }
  const a = tokenize(oldText), b = tokenize(newText)
  if (a.length > 300 || b.length > 300) return { oldHtml: esc(oldText), newHtml: esc(newText) }
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let ii = 1; ii <= m; ii++)
    for (let jj = 1; jj <= n; jj++)
      dp[ii][jj] = a[ii-1] === b[jj-1] ? dp[ii-1][jj-1] + 1 : Math.max(dp[ii-1][jj], dp[ii][jj-1])
  type Op = { t: '='; v: string } | { t: '-'; v: string } | { t: '+'; v: string }
  const ops: Op[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.unshift({ t: '=', v: a[i-1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({ t: '+', v: b[j-1] }); j-- }
    else { ops.unshift({ t: '-', v: a[i-1] }); i-- }
  }
  let oldHtml = '', newHtml = ''
  for (const op of ops) {
    if (op.t === '=') { oldHtml += esc(op.v); newHtml += esc(op.v) }
    else if (op.t === '-') oldHtml += `<mark class="sh-word-del">${esc(op.v)}</mark>`
    else newHtml += `<mark class="sh-word-add">${esc(op.v)}</mark>`
  }
  return { oldHtml, newHtml }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (inString) { if (ch === '\\') escape = true; else if (ch === '"') inString = false; continue }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

export function createReviewPanel(sessionPath?: string): { element: HTMLElement; dispose?: () => void } {
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

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div')
  toolbar.className = 'review-toolbar'

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

  const commentNavWrap = document.createElement('div')
  commentNavWrap.className = 'review-comment-nav hidden'
  const prevCommentBtn = mkIconBtn('', reviewT('prevComment'), 'arrow-left')
  const nextCommentBtn = mkIconBtn('', reviewT('nextComment'), 'arrow-right')
  commentNavWrap.append(prevCommentBtn, nextCommentBtn)

  const viewedCounterEl = Object.assign(document.createElement('span'), { className: 'review-viewed-counter hidden' })

  const REVIEW_AGENT_KEY = 'bento.review.agent'
  const reviewAgentSelect = document.createElement('select')
  reviewAgentSelect.className = 'review-agent-select'
  ;(['claude', 'opencode', 'codex'] as const).forEach(val => {
    reviewAgentSelect.appendChild(Object.assign(document.createElement('option'), {
      value: val, textContent: val === 'claude' ? 'Claude' : val === 'opencode' ? 'OpenCode' : 'Codex',
    }))
  })
  reviewAgentSelect.value = localStorage.getItem(REVIEW_AGENT_KEY) ?? 'claude'
  reviewAgentSelect.addEventListener('change', () => localStorage.setItem(REVIEW_AGENT_KEY, reviewAgentSelect.value))

  toolbar.append(baseLabel, branchWrap, openBtn, refreshBtn, autoBtn, expandAllBtn, collapseAllBtn, treeViewBtn, splitViewBtn, copyDiffBtn, reviewAgentSelect, aiReviewBtn, commentNavWrap, viewedCounterEl)

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

  detail.append(diffSearchInput, filterBar, diffView, commentBar)
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

  // Body is always visible — empty state shows inside diffView, never hides the panel
  root.append(toolbar, body)

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
  const buildCommentBubble = (c: GhComment): HTMLElement => {
    const bubble = document.createElement('div')
    bubble.className = 'review-existing-comment'
    bubble.dataset.commentId = String(c.id)
    if (resolvedComments.has(c.id)) bubble.classList.add('review-existing-comment--resolved')

    const header = document.createElement('div')
    header.className = 'review-existing-comment-header'
    const userSpan = Object.assign(document.createElement('span'), { className: 'review-comment-author', textContent: c.user.login })
    const editBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn', textContent: reviewT('editComment') })
    const replyBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn', textContent: reviewT('replyComment') })
    const deleteBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn review-comment-delete-btn', textContent: reviewT('deleteComment') })
    const resolveBtn = Object.assign(document.createElement('button'), {
      className: 'review-resolve-btn',
      textContent: resolvedComments.has(c.id) ? reviewT('unresolveComment') : reviewT('resolveComment'),
    })
    if (c.created_at) {
      const timeSpan = Object.assign(document.createElement('span'), { className: 'review-comment-time', textContent: relativeTime(c.created_at) })
      header.append(userSpan, timeSpan, editBtn, replyBtn, deleteBtn, resolveBtn)
    } else {
      header.append(userSpan, editBtn, replyBtn, deleteBtn, resolveBtn)
    }

    const bodyEl = Object.assign(document.createElement('div'), { className: 'review-existing-comment-body', textContent: c.body })
    bubble.append(header, bodyEl)

    bubble.addEventListener('click', e => {
      if ((e.target as Element).closest('button')) return
      if (bubble.classList.contains('review-existing-comment--resolved')) {
        bubble.classList.toggle('review-existing-comment--expanded')
      }
    })
    resolveBtn.addEventListener('click', () => {
      const nowResolved = !resolvedComments.has(c.id)
      setCommentResolved(c.id, nowResolved)
      bubble.classList.toggle('review-existing-comment--resolved', nowResolved)
      bubble.classList.remove('review-existing-comment--expanded')
      resolveBtn.textContent = nowResolved ? reviewT('unresolveComment') : reviewT('resolveComment')
    })

    editBtn.addEventListener('click', () => {
      if (bubble.querySelector('.review-edit-wrap')) return
      const editArea = document.createElement('textarea')
      editArea.className = 'review-comment-input'
      editArea.value = c.body
      editArea.rows = 3
      const actions = document.createElement('div')
      actions.className = 'review-line-form-actions'
      const saveBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: 'Save' })
      const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
      actions.append(cancelBtn, saveBtn)
      const wrap = document.createElement('div')
      wrap.className = 'review-edit-wrap'
      wrap.append(editArea, actions)
      bodyEl.after(wrap)
      bodyEl.classList.add('hidden')
      editArea.focus()
      cancelBtn.addEventListener('click', () => { wrap.remove(); bodyEl.classList.remove('hidden') })
      saveBtn.addEventListener('click', async () => {
        const newBody = editArea.value.trim()
        if (!newBody) return
        saveBtn.disabled = true
        try {
          await invoke('gh_pr_update_comment', { path: repoPath, commentId: c.id, body: newBody })
          await loadExistingComments()
          injectExistingComments()
        } catch (err) { console.error(err) } finally { saveBtn.disabled = false }
      })
    })

    deleteBtn.addEventListener('click', async () => {
      if (!confirm(reviewT('deleteConfirm'))) return
      try {
        await invoke('gh_pr_delete_comment', { path: repoPath, commentId: c.id })
        await loadExistingComments()
        injectExistingComments()
      } catch (err) { console.error(err) }
    })

    replyBtn.addEventListener('click', () => {
      if (bubble.querySelector('.review-reply-wrap')) return
      const replyArea = document.createElement('textarea')
      replyArea.className = 'review-comment-input'
      replyArea.placeholder = reviewT('commentPlaceholder')
      replyArea.rows = 2
      const actions = document.createElement('div')
      actions.className = 'review-line-form-actions'
      const sendBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: reviewT('sendComment') })
      const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
      actions.append(cancelBtn, sendBtn)
      const wrap = document.createElement('div')
      wrap.className = 'review-reply-wrap'
      wrap.append(replyArea, actions)
      bubble.append(wrap)
      replyArea.focus()
      cancelBtn.addEventListener('click', () => wrap.remove())
      sendBtn.addEventListener('click', async () => {
        const body = replyArea.value.trim()
        if (!body) return
        sendBtn.disabled = true
        try {
          await invoke('gh_pr_reply_comment', { path: repoPath, commentId: c.id, body })
          await loadExistingComments()
          injectExistingComments()
        } catch (err) { console.error(err) } finally { sendBtn.disabled = false }
      })
    })

    return bubble
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
      prList.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-pr-list-empty', textContent: reviewT('noPrs') }))
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
        // Auto-set base branch from PR's base
        const prBase = allBranches.find(b => b.endsWith('/' + pr.baseRefName)) ?? ('origin/' + pr.baseRefName)
        baseBranch = prBase
        branchInput.value = prBase
        localStorage.setItem(BASE_KEY, baseBranch)
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
    if (mode === 'prs') { renderPrList(); if (!openPrs.length) loadPrList() }
  }
  branchesTab.addEventListener('click', () => setSidebarMode('branches'))
  prsTab.addEventListener('click', () => setSidebarMode('prs'))

  // ── Base dropdown ─────────────────────────────────────────────────────────
  const renderBaseDropdown = (): void => {
    const q = branchInput.value.toLowerCase()
    const matches = q ? allBranches.filter(b => b.toLowerCase().includes(q)) : allBranches
    branchDropdown.replaceChildren(...matches.slice(0, 20).map(b => {
      const item = Object.assign(document.createElement('div'), {
        className: `review-branch-option${b === baseBranch ? ' review-branch-option--active' : ''}`, textContent: b,
      })
      item.addEventListener('mousedown', e => {
        e.preventDefault(); baseBranch = b; branchInput.value = b
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

  // ── Inline comment form (with draft) ─────────────────────────────────────
  const makeLineForm = (filePath: string, line: number, startLine?: number): HTMLElement => {
    const form = document.createElement('div')
    form.className = 'review-line-form'
    const input = document.createElement('textarea')
    input.className = 'review-comment-input'
    input.placeholder = reviewT('commentPlaceholder')
    input.rows = 3
    const draftKey = `bento.review.draft.${repoPath}.${selectedBranch}.${filePath}.${line}`
    const saved = localStorage.getItem(draftKey)
    if (saved) input.value = saved
    input.addEventListener('input', () => {
      if (input.value) localStorage.setItem(draftKey, input.value); else localStorage.removeItem(draftKey)
    })
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
        const url = await invoke<string>('gh_pr_inline_comment', { path: repoPath, prNumber: currentPrNumber, commitId, file: filePath, line, startLine, body })
        localStorage.removeItem(draftKey)
        input.value = ''
        showSentLink(status, url)
        await loadExistingComments()
        injectExistingComments()
        setTimeout(() => form.remove(), 4000)
      } catch (err) {
        status.textContent = String(err)
        status.className = 'review-comment-status review-comment-err'
      } finally { sendBtn.disabled = false }
    })
    return form
  }

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
      const raw = selectedBranch === activeLocalBranch
        ? await diffGit.reviewWorktreeDiff(repoPath, baseBranch)
        : await invoke<string>('git_ref_diff', { path: repoPath, base: baseBranch, target: selectedBranch })
      if (!raw.trim()) {
        totalFiles = 0; lastFiles = []; updateViewedCounter()
        diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-no-changes', textContent: reviewT('noBranchChanges', { base: baseBranch }) }))
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
        number: number; title: string; url: string; body: string
        statusCheckRollup: Array<{ name?: string; workflowName?: string; conclusion?: string | null; state?: string; context?: string; targetUrl?: string }>
        reviewDecision: string | null
      } | null>('gh_pr_view_branch', { path: repoPath, branch: ghBranch(selectedBranch) })
      if (prInfoSeq !== myPrSeq) return
      if (pr) {
        currentPrNumber = pr.number
        currentPrTitle = pr.title
        currentPrBody = pr.body ?? ''
        lastStatusRollup = pr.statusCheckRollup ?? []
        const link = Object.assign(document.createElement('a'), { className: 'review-pr-link', textContent: `PR #${pr.number}: ${pr.title}`, href: '#' })
        link.addEventListener('click', e => { e.preventDefault(); openUrl(pr.url).catch(() => {}) })
        prMetaEl.append(link)

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
    } catch { /* no PR */ }
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
    if (on) intervalId = setInterval(() => { if (selectedBranch) loadDiff() }, 5000)
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

  aiReviewBtn.addEventListener('click', async () => {
    const showReviewError = (message: string): void => {
      console.error('[AI Review]', message)
      const error = Object.assign(document.createElement('div'), { className: 'review-error', textContent: message })
      diffView.prepend(error)
      error.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    if (!repoPath) { showReviewError('Open a repository first'); return }
    if (!selectedBranch) { showReviewError('Select a branch first'); return }
    if (!lastFiles.length) { showReviewError('There are no changes to review'); return }
    const reviewRepoPath = repoPath
    const reviewBranch = selectedBranch
    const reviewBaseBranch = baseBranch
    const reviewAgent = reviewAgentSelect.value as 'claude' | 'opencode' | 'codex'
    const reviewConversationKey = techReviewConversationKey(reviewRepoPath, reviewBranch)
    const reviewProjectName = reviewRepoPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? reviewRepoPath
    const MAX_DIFF_CHARS = 18_000
    const rawDiff = lastFiles.map(f => f.chunk).join('\n')
    const diff = rawDiff.length > MAX_DIFF_CHARS
      ? rawDiff.slice(0, MAX_DIFF_CHARS) + `\n\n[diff truncated — ${lastFiles.length} files total]`
      : rawDiff
    const prLine = currentPrNumber ? `PR #${currentPrNumber}: ${currentPrTitle}` : `Branch: ${reviewBranch}`
    const descSection = currentPrBody.trim() ? `\nDescription:\n${currentPrBody.trim()}\n` : ''
    const reviewDiff = `${prLine}\nBase: ${reviewBaseBranch} <- ${reviewBranch}\n${descSection}\n${diff}`
    const reviewFiles = lastFiles.map(file => ({ path: file.file, content: file.chunk }))
    const reviewChangedFiles = reviewFiles.map(file => file.path)
    let prompt: string
    aiReviewBtn.disabled = true
    aiReviewBtn.title = 'Reviewing...'
    let output = ''
    const reviewEvidence: string[] = []

    // Progress box visible desde el principio
    const progressBox = document.createElement('div')
    progressBox.className = 'review-ai-progress'
    const progressHeader = document.createElement('div')
    progressHeader.className = 'review-ai-progress-header'
    const progressStatus = Object.assign(document.createElement('span'), { className: 'review-ai-progress-status', textContent: 'Preparing review…' })
    const progressMeta = Object.assign(document.createElement('span'), { className: 'review-ai-progress-meta' })
    progressHeader.append(progressStatus, progressMeta)
    const progressStream = Object.assign(document.createElement('pre'), { className: 'review-ai-progress-stream' })
    progressBox.append(progressHeader, progressStream)
    diffView.prepend(progressBox)
    progressBox.scrollIntoView({ block: 'start', behavior: 'smooth' })

    const startedAt = Date.now()
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000)
      const chars = output.length
      progressMeta.textContent = chars ? `${chars} chars · ${secs}s` : `${secs}s`
    }, 500)

    const showResult = (result: ReviewResponse, reviewCommit: string, sessionId: string | null): void => {
      progressBox.remove()
      const verdictIcon = result.verdict === 'pass' ? '✅' : result.verdict === 'fail' ? '❌' : '⚠️'
      const lines = [
        `## Revisión: ${reviewBranch}`,
        `Base: \`${reviewBaseBranch}\` · Commit: \`${reviewCommit.slice(0, 7)}\``,
        `${verdictIcon} **${result.verdict}** — ${result.summary}`,
      ]
      if (result.findings.length) {
        lines.push('')
        result.findings.forEach(f => {
          lines.push(`**${f.severity.toUpperCase()}** \`${f.file}${f.line ? `:${f.line}` : ''}\` — ${f.title}`)
          lines.push(f.explanation)
          lines.push(`→ ${f.recommendation}`)
          lines.push('')
        })
      }
      askAi('', false, undefined, undefined, { role: 'assistant', content: lines.join('\n') }, reviewRepoPath, reviewAgent, reviewConversationKey, `${reviewProjectName} · ${reviewBranch}`, reviewBranch, reviewCommit, sessionId ?? undefined, reviewEvidence)
    }
    let worktree = ''
    let managedWorktree = false
    let handle: ReturnType<typeof startAgent> | undefined
    try {
      progressStatus.textContent = 'Creating isolated worktree…'
      const branchContext = await invoke<{ path: string; commit: string; managed: boolean }>('review_branch_context_prepare', {
        repoPath: reviewRepoPath,
        reference: reviewBranch,
        commit: null,
      })
      worktree = branchContext.path
      managedWorktree = branchContext.managed
      const snapshotBefore = await invoke<string>('review_snapshot', { repoPath: worktree })
      progressStatus.textContent = 'Gathering context…'
      const contextProvider = createContextProvider({
        lexis: async () => {
          const content = await invoke<string>('review_lexis_context', {
            path: worktree,
            question: `Find relevant callers, definitions and tests for: ${reviewChangedFiles.join(', ')}`,
          })
          if (!content) throw new Error('Lexis returned no context')
          return [{ path: '<lexis>', content, reason: 'reference' as const }]
        },
        direct: async () => reviewFiles.map(file => ({ ...file, reason: 'changed' as const })),
      })
      const context = await contextProvider.collect({ repoRoot: worktree, diff: reviewDiff, changedFiles: reviewChangedFiles })
      prompt = buildReviewPrompt({
        diff: reviewDiff,
        files: reviewFiles,
        contextSources: context.sources,
        lexisContext: context.snippets.filter(snippet => snippet.reason !== 'changed').map(snippet => `${snippet.path}\n${snippet.content}`).join('\n\n'),
      })
      const snapshotBeforeAgent = await invoke<string>('review_snapshot', { repoPath: worktree })
      if (snapshotBeforeAgent !== snapshotBefore) throw new Error('Repository changed while preparing the review')
      const agentLabel = reviewAgent === 'claude' ? 'Claude' : reviewAgent === 'opencode' ? 'OpenCode' : 'Codex'
      progressStatus.textContent = `${agentLabel} is reviewing…`
      let finishResult!: () => void
      const resultFinished = new Promise<void>(resolve => { finishResult = resolve })
      handle = startAgent(
        { agent: reviewAgent, message: prompt, history: [], projectPath: worktree, review: true },
        chunk => {
          output += chunk
          progressStream.textContent = output.length > 1200 ? '…' + output.slice(-1200) : output
        },
        sessionId => {
          void (async () => {
            try {
              const json = extractFirstJsonObject(output)
              if (!json) throw new Error('No JSON object found in response')
              const result = validateReviewResponse(JSON.parse(json))
              await Promise.all(result.findings.map(finding => invoke('review_validate_finding_path', { repoPath: worktree, relative: finding.file })))
              showResult(result, branchContext.commit, sessionId)
            } catch (error) { progressBox.remove(); showReviewError(`Invalid AI review: ${String(error)}`) }
            finally { finishResult() }
          })()
        },
        message => { progressBox.remove(); showReviewError(message); finishResult() },
        tool => {
          const safeTool = redact(tool).slice(0, 1_000)
          if (!reviewEvidence.includes(safeTool)) reviewEvidence.push(safeTool)
          progressStatus.textContent = `${agentLabel}: ${safeTool}`
        },
      )
      await handle.ready
      await handle.completed
      await resultFinished
      const snapshotAfter = await invoke<string>('review_snapshot', { repoPath: worktree })
      if (snapshotAfter !== snapshotBefore) showReviewError('Repository changed during review; findings may be stale')
    } catch (error) { progressBox.remove(); showReviewError(String(error)) }
    finally {
      clearInterval(timer)
      progressBox.remove()  // no-op si ya fue quitado por showResult/onError
      handle?.unlisten()
      if (managedWorktree) {
        await invoke('review_branch_context_release', {
          repoPath: reviewRepoPath,
          reference: reviewBranch,
        }).catch(error => showReviewError(String(error)))
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
  }
}
