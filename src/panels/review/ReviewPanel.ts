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
  id: number
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
  baseRefName: string
  author: { login: string }
}

type SidebarMode = 'branches' | 'prs'
type FileTypeFilter = 'all' | 'A' | 'M' | 'D'

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

export function createReviewPanel(sessionPath?: string): { element: HTMLElement; dispose?: () => void } {
  const root = document.createElement('div')
  root.className = 'review-panel'

  // Bug fix: use || so empty string from ctx.projectPath falls through to localStorage
  let repoPath: string = (sessionPath || localStorage.getItem(REPO_KEY)) ?? ''
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
  let focusedFileIdx = -1
  let treeView = false
  let lastFiles: Array<ReturnType<typeof parseDiffFiles>[0] & { state: 'A'|'D'|'M' }> = []
  let lastStatusRollup: Array<{ name?: string; workflowName?: string; conclusion?: string|null; state?: string; context?: string; targetUrl?: string }> = []

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

  const commentNavWrap = document.createElement('div')
  commentNavWrap.className = 'review-comment-nav hidden'
  const prevCommentBtn = mkIconBtn('', reviewT('prevComment'), 'arrow-left')
  const nextCommentBtn = mkIconBtn('', reviewT('nextComment'), 'arrow-right')
  commentNavWrap.append(prevCommentBtn, nextCommentBtn)

  const viewedCounterEl = Object.assign(document.createElement('span'), { className: 'review-viewed-counter hidden' })

  toolbar.append(baseLabel, branchWrap, openBtn, refreshBtn, autoBtn, expandAllBtn, collapseAllBtn, treeViewBtn, commentNavWrap, viewedCounterEl)

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
  // kept for call sites that pass false (repo picked)
  const setEmptyVisible = (on: boolean): void => { if (on) showNoRepo() }

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
    popover.style.top = `${anchorRect.bottom - rootRect.top + 4}px`
    popover.style.left = `${anchorRect.left - rootRect.left}px`
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

    const header = document.createElement('div')
    header.className = 'review-existing-comment-header'
    const userSpan = Object.assign(document.createElement('span'), { className: 'review-comment-author', textContent: c.user.login })
    const editBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn', textContent: reviewT('editComment') })
    const replyBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn', textContent: reviewT('replyComment') })
    const deleteBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn review-comment-delete-btn', textContent: reviewT('deleteComment') })
    header.append(userSpan, editBtn, replyBtn, deleteBtn)

    const bodyEl = Object.assign(document.createElement('div'), { className: 'review-existing-comment-body', textContent: c.body })
    bubble.append(header, bodyEl)

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
      input.value ? localStorage.setItem(draftKey, input.value) : localStorage.removeItem(draftKey)
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
          e.preventDefault(); dragStart = capturedLine
          highlightRange(capturedLine, capturedLine)
          document.addEventListener('mousemove', onMouseMove)
          document.addEventListener('mouseup', onMouseUp)
        })
        lineEl.append(addBtn)
      }

      const content = document.createElement('span')
      const isCodeLine = !isHunk && !isMeta
      if (isCodeLine) {
        const prefix = raw[0] ?? ''
        const code = raw.slice(1)
        content.innerHTML = `<span class="tasks-diff-line-no">${fileLine ?? ''}</span>${esc(prefix)}${highlightCode(code, ext)}`
      } else {
        content.innerHTML = `<span class="tasks-diff-line-no">${fileLine ?? ''}</span>${esc(raw)}`
      }
      lineEl.append(content)
      wrap.append(lineEl)
      container.append(wrap)
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
    const sum = document.createElement('summary')
    sum.className = 'review-file-summary'
    sum.append(viewedCb, stateTag, nameEl, editorBtn, statsEl)
    details.append(sum, buildFileDiff(f.chunk, f.file))
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
    diffView.querySelectorAll<HTMLElement>('.review-file-detail').forEach(el => {
      const state = el.dataset.filestate ?? 'M'
      const filename = el.dataset.filename ?? ''
      const failsType = fileTypeFilter !== 'all' && state !== fileTypeFilter
      const failsSearch = q !== '' && !filename.toLowerCase().includes(q)
      el.classList.toggle('hidden', failsType || failsSearch)
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
    filterBar.replaceChildren(
      mkBtn(`All ${total}`, 'all'),
      mkBtn(`+${counts.A} Added`, 'A'),
      mkBtn(`~${counts.M} Modified`, 'M'),
      mkBtn(`−${counts.D} Deleted`, 'D'),
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
      lineWrap.after(buildCommentBubble(c))
    }
    updateCommentNav()
  }

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
    diffSearchInput.classList.add('hidden')
    fileTypeFilter = 'all'
    diffView.replaceChildren(Object.assign(document.createElement('div'), { className: 'review-loading', textContent: reviewT('loading') }))
    try {
      const raw = await invoke<string>('git_ref_diff', { path: repoPath, base: baseBranch, target: selectedBranch })
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
    currentPrNumber = null; existingComments = []
    prMetaEl.replaceChildren(); prBodyEl.classList.add('hidden'); commentBar.classList.add('hidden')
    lastStatusRollup = []
    try {
      const pr = await invoke<{
        number: number; title: string; url: string; body: string
        statusCheckRollup: Array<{ name?: string; workflowName?: string; conclusion?: string | null; state?: string; context?: string; targetUrl?: string }>
        reviewDecision: string | null
      } | null>('gh_pr_view_branch', { path: repoPath, branch: ghBranch(selectedBranch) })
      if (pr) {
        currentPrNumber = pr.number
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

        if (pr.body?.trim()) { prBodyEl.textContent = pr.body; prBodyEl.classList.remove('hidden') }
        commentBar.classList.remove('hidden')
        await loadExistingComments()
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
    if (lastFiles.length) renderFiles()
  })

  // ── Load branches ─────────────────────────────────────────────────────────
  const loadBranches = async (): Promise<void> => {
    if (!repoPath) return
    const [defaultBranch, branches] = await Promise.all([diffGit.defaultBranch(repoPath), diffGit.remoteBranches(repoPath)])
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
    selectedBranch = ''; existingComments = []; totalFiles = 0
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
