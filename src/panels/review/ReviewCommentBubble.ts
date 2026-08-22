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
    const editArea = document.createElement('textarea')
    editArea.className = 'review-comment-input'
    editArea.value = c.body
    editArea.rows = 3
    const actionsRow = document.createElement('div')
    actionsRow.className = 'review-line-form-actions'
    const saveBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: 'Save' })
    const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
    actionsRow.append(cancelBtn, saveBtn)
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
    const replyArea = document.createElement('textarea')
    replyArea.className = 'review-comment-input'
    replyArea.placeholder = reviewT('commentPlaceholder')
    replyArea.rows = 2
    const actionsRow = document.createElement('div')
    actionsRow.className = 'review-line-form-actions'
    const sendBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: reviewT('sendComment') })
    const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
    actionsRow.append(cancelBtn, sendBtn)
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
  const input = document.createElement('textarea')
  input.className = 'review-comment-input'
  input.placeholder = reviewT('commentPlaceholder')
  input.rows = 3
  const draftKey = `bento.review.draft.${actions.repoPath()}.${actions.selectedBranch()}.${filePath}.${line}`
  const saved = localStorage.getItem(draftKey)
  if (saved) input.value = saved
  input.addEventListener('input', () => {
    if (input.value) localStorage.setItem(draftKey, input.value); else localStorage.removeItem(draftKey)
  })
  const actionsRow = document.createElement('div')
  actionsRow.className = 'review-line-form-actions'
  const sendBtn = Object.assign(document.createElement('button'), { className: 'review-comment-btn', textContent: reviewT('sendComment') })
  const cancelBtn = Object.assign(document.createElement('button'), { className: 'review-line-cancel-btn', textContent: 'Cancel' })
  const status = Object.assign(document.createElement('span'), { className: 'review-comment-status' })
  actionsRow.append(cancelBtn, sendBtn, status)
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
