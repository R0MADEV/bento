import { reviewT } from './i18n'
import { t as i18nT } from '../../i18n'

// Las tres piezas del panel que son solo estructura: la barra de comentarios
// del PR, el cajón donde aparece la review de la IA y el estado vacío. Cada
// una devuelve sus refs; quién las rellena es el panel.

export function buildCommentBar(): {
  commentBar: HTMLElement
  prMetaEl: HTMLElement
  prBodyEl: HTMLElement
  discussionEl: HTMLElement
  commentInput: HTMLTextAreaElement
  commentBtn: HTMLButtonElement
  approveBtn: HTMLButtonElement
  requestChangesBtn: HTMLButtonElement
  commentStatus: HTMLSpanElement
} {
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

  return { commentBar, prMetaEl, prBodyEl, discussionEl, commentInput, commentBtn, approveBtn, requestChangesBtn, commentStatus }
}

export function buildReviewDrawer(): {
  reviewDrawer: HTMLElement
  reviewDrawerMeta: HTMLElement
  reviewDrawerBody: HTMLElement
  reviewDrawerCloseBtn: HTMLButtonElement
} {
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

  return { reviewDrawer, reviewDrawerMeta, reviewDrawerBody, reviewDrawerCloseBtn }
}

export function buildEmptyState(): { emptyState: HTMLElement; emptyOpenBtn: HTMLButtonElement } {
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

  return { emptyState, emptyOpenBtn }
}
