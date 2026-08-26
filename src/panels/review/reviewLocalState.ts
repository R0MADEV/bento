import { reviewT } from './i18n'

// Lo que el panel recuerda por su cuenta en el navegador: qué archivos has
// mirado y qué comentarios das por resueltos. Son marcas de lectura, no datos
// del repo, y por eso no viajan al almacén compartido.

export interface ReviewLocalStateDeps {
  repoPath: () => string
  selectedBranch: () => string
  currentPrNumber: () => number | null
  totalFiles: () => number
  viewedCounterEl: HTMLElement
}

export interface ReviewLocalState {
  getViewedFiles: () => Set<string>
  setFileViewed: (file: string, viewed: boolean) => void
  updateViewedCounter: () => void
  getResolvedComments: () => Set<number>
  setCommentResolved: (id: number, resolved: boolean) => void
}

export function buildReviewLocalState(deps: ReviewLocalStateDeps): ReviewLocalState {
  // ── Viewed files ──────────────────────────────────────────────────────────
  const viewedKey = (): string => `bento.review.viewed.${deps.repoPath()}.${deps.selectedBranch()}`
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
    if (deps.totalFiles() === 0) { deps.viewedCounterEl.classList.add('hidden'); return }
    const done = getViewedFiles().size
    deps.viewedCounterEl.textContent = reviewT('reviewedCount', { done, total: deps.totalFiles() })
    deps.viewedCounterEl.classList.remove('hidden')
  }

  // ── Resolved comments ─────────────────────────────────────────────────────
  const resolvedKey = (): string => `bento.review.resolved.${deps.repoPath()}.${deps.currentPrNumber() ?? ''}`
  const getResolvedComments = (): Set<number> => {
    try { return new Set(JSON.parse(localStorage.getItem(resolvedKey()) ?? '[]') as number[]) }
    catch { return new Set() }
  }
  const setCommentResolved = (id: number, resolved: boolean): void => {
    const set = getResolvedComments()
    if (resolved) set.add(id); else set.delete(id)
    localStorage.setItem(resolvedKey(), JSON.stringify([...set]))
    /* el panel relee con getResolvedComments */
  }

  return { getViewedFiles, setFileViewed, updateViewedCounter, getResolvedComments, setCommentResolved }
}
