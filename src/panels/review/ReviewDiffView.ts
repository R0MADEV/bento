import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/icons'
import { reviewT } from './i18n'
import type { ReviewChangeFile, GhComment, FileTypeFilter } from './reviewFormat'
import { esc, highlightCode, wordDiff } from './reviewFormat'

export interface ReviewDiffDom {
  diffView: HTMLElement
  diffSearchInput: HTMLInputElement
  filterBar: HTMLElement
}

export interface ReviewDiffState {
  getLastFiles: () => ReviewChangeFile[]
  getTreeView: () => boolean
  getSplitView: () => boolean
  getExistingComments: () => GhComment[]
  getFileTypeFilter: () => FileTypeFilter
  setFileTypeFilter: (value: FileTypeFilter) => void
  resetFocusedFileIdx: () => void
  getViewedFiles: () => Set<string>
  setFileViewed: (file: string, viewed: boolean) => void
  repoPath: () => string
  getCurrentPrNumber: () => number | null
  getPrIdentifier: () => string
  buildCommentBubble: (c: GhComment) => HTMLElement
  makeLineForm: (filePath: string, line: number, startLine?: number) => HTMLElement
  updateCommentNav: () => void
  showSentLink: (el: HTMLElement, url: string) => void
}

export interface ReviewDiffView {
  renderFiles: () => void
  applyVisibility: () => void
  injectExistingComments: () => void
  updateCommentBadges: () => void
}

export function buildReviewDiffView(dom: ReviewDiffDom, state: ReviewDiffState): ReviewDiffView {
  const { diffView, diffSearchInput, filterBar } = dom

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
      const form = state.makeLineForm(filePath, hi, lo < hi ? lo : undefined)
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
      const form = state.makeLineForm(filePath, hi, lo < hi ? lo : undefined)
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
  const makeFileDetails = (f: ReviewChangeFile): HTMLDetailsElement => {
    const viewedSet = state.getViewedFiles()
    const details = document.createElement('details')
    details.className = 'review-file-detail'
    details.dataset.filestate = f.state
    details.dataset.filename = f.file
    details.open = state.getLastFiles().length <= 5
    details.classList.toggle('review-file-viewed', viewedSet.has(f.file))

    const viewedCb = document.createElement('input')
    viewedCb.type = 'checkbox'; viewedCb.className = 'review-viewed-cb'
    viewedCb.checked = viewedSet.has(f.file); viewedCb.title = reviewT('viewed')
    viewedCb.addEventListener('click', e => e.stopPropagation())
    viewedCb.addEventListener('change', e => {
      e.stopPropagation()
      state.setFileViewed(f.file, viewedCb.checked)
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
      invoke('open_in_editor', { path: `${state.repoPath()}/${f.file}` }).catch(() => {})
    })
    const statsEl = document.createElement('span')
    statsEl.className = 'review-file-stats'
    statsEl.append(
      Object.assign(document.createElement('span'), { className: 'review-stat-add', textContent: `+${f.additions}` }),
      Object.assign(document.createElement('span'), { className: 'review-stat-del', textContent: `-${f.deletions}` }),
    )

    const fileCommentCount = state.getExistingComments().filter(c => c.path === f.file).length
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
        if (!body || state.getCurrentPrNumber() === null) return
        sendBtn.disabled = true
        try {
          const url = await invoke<string>('gh_pr_comment', { path: state.repoPath(), branch: state.getPrIdentifier(), body: `**${f.file}**\n\n${body}` })
          ta.value = ''; state.showSentLink(st, url)
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
    details.append(sum, state.getSplitView() ? buildFileDiffSideBySide(f.chunk, f.file) : buildFileDiff(f.chunk, f.file))
    return details
  }

  // ── Render files (flat or tree) ───────────────────────────────────────────
  const renderFiles = (): void => {
    state.resetFocusedFileIdx()
    const lastFiles = state.getLastFiles()
    if (!state.getTreeView()) {
      diffView.replaceChildren(...lastFiles.map(f => makeFileDetails(f)))
    } else {
      const dirs = new Map<string, ReviewChangeFile[]>()
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
    const commentedPaths = new Set(state.getExistingComments().map(c => c.path))
    const fileTypeFilter = state.getFileTypeFilter()
    diffView.querySelectorAll<HTMLElement>('.review-file-detail').forEach(el => {
      const s = el.dataset.filestate ?? 'M'
      const filename = el.dataset.filename ?? ''
      const isCommentedFilter = fileTypeFilter === 'commented'
      const failsType = !isCommentedFilter && fileTypeFilter !== 'all' && s !== fileTypeFilter
      const failsCommented = isCommentedFilter && !commentedPaths.has(filename)
      const failsSearch = q !== '' && !filename.toLowerCase().includes(q)
      el.classList.toggle('hidden', failsType || failsCommented || failsSearch)
    })
  }

  diffSearchInput.addEventListener('input', applyVisibility)

  // ── Filter bar ────────────────────────────────────────────────────────────
  const renderFilterBar = (): void => {
    const lastFiles = state.getLastFiles()
    const counts = { A: 0, M: 0, D: 0 }
    lastFiles.forEach(f => { counts[f.state]++ })
    const total = lastFiles.length
    if (total === 0) { filterBar.classList.add('hidden'); return }
    filterBar.classList.remove('hidden')
    const mkBtn = (label: string, value: FileTypeFilter): HTMLButtonElement => {
      const btn = Object.assign(document.createElement('button'), {
        className: `review-filter-btn${state.getFileTypeFilter() === value ? ' review-filter-btn--active' : ''}`, textContent: label,
      })
      btn.addEventListener('click', () => {
        state.setFileTypeFilter(value)
        filterBar.querySelectorAll('.review-filter-btn').forEach(b => b.classList.remove('review-filter-btn--active'))
        btn.classList.add('review-filter-btn--active')
        applyVisibility()
      })
      return btn
    }
    const commentedPaths = new Set(state.getExistingComments().map(c => c.path))
    const commentedCount = lastFiles.filter(f => commentedPaths.has(f.file)).length
    if (state.getFileTypeFilter() === 'commented' && commentedCount === 0) state.setFileTypeFilter('all')
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
      const count = state.getExistingComments().filter(c => c.path === filename).length
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

    for (const c of state.getExistingComments()) {
      const fileContainer = fileContainers.find(el => el.dataset.filepath === c.path)
      if (!fileContainer) continue
      const lineWrap = fileContainer.querySelector<HTMLElement>(`[data-line="${c.line}"]`)
      if (lineWrap) {
        // Line is visible in the diff — inject inline
        const insertAnchor = lineWrap.closest('.review-split-row') ?? lineWrap
        insertAnchor.after(state.buildCommentBubble(c))
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
        const bubble = state.buildCommentBubble(c)
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
    state.updateCommentNav()
  }

  return { renderFiles, applyVisibility, injectExistingComments, updateCommentBadges }
}
