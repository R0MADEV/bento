// Moverse por la review sin ratón: n/p entre comentarios, j/k entre archivos,
// v marca el que tienes delante y u salta al primero sin revisar.

export interface ReviewNavigationDeps {
  diffView: HTMLElement
  commentNavWrap: HTMLElement
  getViewedFiles: () => Set<string>
}

export interface ReviewNavigation {
  updateCommentNav: () => void
  /// El render de archivos reinicia el foco: lo que estaba enfocado ya no existe.
  resetFocusedFile: () => void
  navigateComment: (dir: 1 | -1) => void
  navigateFile: (dir: 1 | -1) => void
  toggleCurrentViewed: () => void
  navigateUnviewed: () => void
  handleKeydown: (e: KeyboardEvent, isConnected: boolean) => void
}

export function buildReviewNavigation(deps: ReviewNavigationDeps): ReviewNavigation {
  let commentNavIdx = -1
  let focusedFileIdx = -1
  const { diffView, commentNavWrap } = deps
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
    const viewedSet = deps.getViewedFiles()
    const files = [...diffView.querySelectorAll<HTMLElement>('.review-file-detail:not(.hidden)')]
    const target = files.find(el => !viewedSet.has(el.dataset.filename ?? ''))
    if (!target) return
    files.forEach(f => f.classList.remove('review-file-focused'))
    focusedFileIdx = files.indexOf(target)
    target.classList.add('review-file-focused')
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const handleKeydown = (e: KeyboardEvent, isConnected: boolean): void => {
    if (!isConnected) return
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
  // Quien lo monta decide cuándo escuchar y cuándo dejar de hacerlo.
  const resetFocusedFile = (): void => { focusedFileIdx = -1 }

  return { updateCommentNav, resetFocusedFile, navigateComment, navigateFile, toggleCurrentViewed, navigateUnviewed, handleKeydown }
}
