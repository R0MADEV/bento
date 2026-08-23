import { invoke } from '@tauri-apps/api/core'
import type { GhComment } from './reviewFormat'
import { relativeTime } from './reviewFormat'
import { reviewT } from './i18n'

export interface ReviewCommentActions {
  repoPath: () => string
  isResolved: (id: number) => boolean
  setResolved: (id: number, resolved: boolean) => void
  refresh: () => Promise<void>
}

// A textarea + Cancel/Send actions row, the shared shape behind every comment
// form in the review panel (edit, reply, inline line-comment, file-comment).
// `status` is always created (callers that don't need it just leave it
// unappended-to-DOM) so callers get a uniform, non-optional return shape.
export interface CommentInputRow {
  textarea: HTMLTextAreaElement
  actionsRow: HTMLElement
  sendBtn: HTMLButtonElement
  cancelBtn: HTMLButtonElement
  status: HTMLSpanElement
}

export function buildCommentInputRow(options: {
  rows: number
  placeholder?: string
  value?: string
  sendLabel: string
  withStatus?: boolean
}): CommentInputRow {
  const textarea = document.createElement('textarea')
  textarea.className = 'review-comment-input'
  textarea.rows = options.rows
  if (options.placeholder) textarea.placeholder = options.placeholder
  if (options.value !== undefined) textarea.value = options.value
  const actionsRow = document.createElement('div')
  actionsRow.className = 'review-line-form-actions'
  const sendBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: options.sendLabel })
  const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
  const status = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
  actionsRow.append(cancelBtn, sendBtn)
  if (options.withStatus) actionsRow.append(status)
  return { textarea, actionsRow, sendBtn, cancelBtn, status }
}

// ── Comment bubble (edit/delete/reply) ────────────────────────────────────
export function buildReviewCommentBubble(c: GhComment, actions: ReviewCommentActions): HTMLElement {
  const bubble = document.createElement('div')
  bubble.className = 'review-existing-comment'
  bubble.dataset.commentId = String(c.id)
  if (actions.isResolved(c.id)) bubble.classList.add('review-existing-comment--resolved')

  const header = document.createElement('div')
  header.className = 'review-existing-comment-header'
  const userSpan = Object.assign(document.createElement('span'), { className: 'review-comment-author', textContent: c.user.login })
  const editBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn', textContent: reviewT('editComment') })
  const replyBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn', textContent: reviewT('replyComment') })
  const deleteBtn = Object.assign(document.createElement('button'), { className: 'review-comment-action-btn review-comment-delete-btn', textContent: reviewT('deleteComment') })
  const resolveBtn = Object.assign(document.createElement('button'), {
    className: 'review-resolve-btn',
    textContent: actions.isResolved(c.id) ? reviewT('unresolveComment') : reviewT('resolveComment'),
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
    const nowResolved = !actions.isResolved(c.id)
    actions.setResolved(c.id, nowResolved)
    bubble.classList.toggle('review-existing-comment--resolved', nowResolved)
    bubble.classList.remove('review-existing-comment--expanded')
    resolveBtn.textContent = nowResolved ? reviewT('unresolveComment') : reviewT('resolveComment')
  })

  editBtn.addEventListener('click', () => {
    if (bubble.querySelector('.review-edit-wrap')) return
    const { textarea: editArea, actionsRow, sendBtn: saveBtn, cancelBtn } = buildCommentInputRow({ rows: 3, value: c.body, sendLabel: 'Save' })
    const wrap = document.createElement('div')
    wrap.className = 'review-edit-wrap'
    wrap.append(editArea, actionsRow)
    bodyEl.after(wrap)
    bodyEl.classList.add('hidden')
    editArea.focus()
    cancelBtn.addEventListener('click', () => { wrap.remove(); bodyEl.classList.remove('hidden') })
    saveBtn.addEventListener('click', async () => {
      const newBody = editArea.value.trim()
      if (!newBody) return
      saveBtn.disabled = true
      try {
        await invoke('gh_pr_update_comment', { path: actions.repoPath(), commentId: c.id, body: newBody })
        await actions.refresh()
      } catch (err) { console.error(err) } finally { saveBtn.disabled = false }
    })
  })

  deleteBtn.addEventListener('click', async () => {
    if (!confirm(reviewT('deleteConfirm'))) return
    try {
      await invoke('gh_pr_delete_comment', { path: actions.repoPath(), commentId: c.id })
      await actions.refresh()
    } catch (err) { console.error(err) }
  })

  replyBtn.addEventListener('click', () => {
    if (bubble.querySelector('.review-reply-wrap')) return
    const { textarea: replyArea, actionsRow, sendBtn, cancelBtn } = buildCommentInputRow({ rows: 2, placeholder: reviewT('commentPlaceholder'), sendLabel: reviewT('sendComment') })
    const wrap = document.createElement('div')
    wrap.className = 'review-reply-wrap'
    wrap.append(replyArea, actionsRow)
    bubble.append(wrap)
    replyArea.focus()
    cancelBtn.addEventListener('click', () => wrap.remove())
    sendBtn.addEventListener('click', async () => {
      const body = replyArea.value.trim()
      if (!body) return
      sendBtn.disabled = true
      try {
        await invoke('gh_pr_reply_comment', { path: actions.repoPath(), commentId: c.id, body })
        await actions.refresh()
      } catch (err) { console.error(err) } finally { sendBtn.disabled = false }
    })
  })

  return bubble
}

export interface ReviewLineFormActions {
  repoPath: () => string
  selectedBranch: () => string
  currentPrNumber: () => number | null
  refresh: () => Promise<void>
  showSentLink: (el: HTMLElement, url: string) => void
}

// ── Inline comment form (with draft) ─────────────────────────────────────
export function buildReviewLineForm(filePath: string, line: number, startLine: number | undefined, actions: ReviewLineFormActions): HTMLElement {
  const form = document.createElement('div')
  form.className = 'review-line-form'
  const { textarea: input, actionsRow, sendBtn, cancelBtn, status } =
    buildCommentInputRow({ rows: 3, placeholder: reviewT('commentPlaceholder'), sendLabel: reviewT('sendComment'), withStatus: true })
  const draftKey = `bento.review.draft.${actions.repoPath()}.${actions.selectedBranch()}.${filePath}.${line}`
  const saved = localStorage.getItem(draftKey)
  if (saved) input.value = saved
  input.addEventListener('input', () => {
    if (input.value) localStorage.setItem(draftKey, input.value); else localStorage.removeItem(draftKey)
  })
  form.append(input, actionsRow)
  cancelBtn.addEventListener('click', () => form.remove())
  sendBtn.addEventListener('click', async () => {
    const body = input.value.trim()
    if (!body) { input.focus(); return }
    const prNumber = actions.currentPrNumber()
    if (prNumber === null) { status.textContent = 'No PR for this branch'; return }
    sendBtn.disabled = true
    try {
      const repoPath = actions.repoPath()
      const commitId = await invoke<string>('git_rev_parse', { path: repoPath, reference: actions.selectedBranch() })
      const url = await invoke<string>('gh_pr_inline_comment', { path: repoPath, prNumber, commitId, file: filePath, line, startLine, body })
      localStorage.removeItem(draftKey)
      input.value = ''
      actions.showSentLink(status, url)
      await actions.refresh()
      setTimeout(() => form.remove(), 4000)
    } catch (err) {
      status.textContent = String(err)
      status.className = 'review-comment-status review-comment-err'
    } finally { sendBtn.disabled = false }
  })
  return form
}
