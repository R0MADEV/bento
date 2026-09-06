import { invoke } from '@tauri-apps/api/core'
import { reviewT } from './i18n'

// Qué archivos has mirado y qué comentarios das por resueltos.
//
// Los archivos vistos viven en el almacén compartido con el daemon y la CLI:
// marcar uno aquí y seguir desde el móvil es media razón de que haya un solo
// almacén, y esto se quedaba en el navegador. Los comentarios resueltos sí
// siguen aquí — son de un PR de GitHub, no del repo, y ningún otro cliente
// los mira.

export interface ReviewLocalStateDeps {
  repoPath: () => string
  selectedBranch: () => string
  currentPrNumber: () => number | null
  totalFiles: () => number
  viewedCounterEl: HTMLElement
}

export interface ReviewLocalState {
  getViewedFiles: () => Set<string>
  /** Trae del almacén lo marcado para el repo y la rama de ahora. */
  loadViewedFiles: () => Promise<void>
  setFileViewed: (file: string, viewed: boolean) => void
  updateViewedCounter: () => void
  getResolvedComments: () => Set<number>
  /** Trae del almacén los resueltos del PR abierto. */
  loadResolvedComments: () => Promise<void>
  setCommentResolved: (id: number, resolved: boolean) => void
}

export function buildReviewLocalState(deps: ReviewLocalStateDeps): ReviewLocalState {
  // ── Viewed files ──────────────────────────────────────────────────────────
  // Lo marcado para la rama que se está mirando. En memoria porque el diff se
  // pinta con ello y el almacén está al otro lado de un comando: leerlo por
  // cada casilla pintaría el diff a trompicones.
  let viewed = new Set<string>()
  const legacyKey = (): string => `bento.review.viewed.${deps.repoPath()}.${deps.selectedBranch()}`
  const getViewedFiles = (): Set<string> => viewed

  const loadViewedFiles = async (): Promise<void> => {
    const repoPath = deps.repoPath()
    const branch = deps.selectedBranch()
    if (!repoPath || !branch) { viewed = new Set(); return }
    const stored = await invoke<string[]>('review_viewed_get', { cwd: repoPath, base: branch }).catch(() => [])
    viewed = new Set(stored)
    // Lo que el navegador guardaba antes de que hubiera almacén: se mueve una
    // vez y se borra de aquí, para que desmarcar un archivo no lo resucite.
    if (!viewed.size) {
      const legacy = readLegacy()
      if (legacy.size) {
        viewed = legacy
        await persistViewed()
        localStorage.removeItem(legacyKey())
      }
    }
    updateViewedCounter()
  }

  const readLegacy = (): Set<string> => {
    try { return new Set(JSON.parse(localStorage.getItem(legacyKey()) ?? '[]') as string[]) }
    catch { return new Set() }
  }

  const persistViewed = async (): Promise<void> => {
    await invoke('review_viewed_set', {
      cwd: deps.repoPath(), base: deps.selectedBranch(), paths: [...viewed],
    }).catch(() => {})
  }

  const setFileViewed = (file: string, viewed_: boolean): void => {
    if (viewed_) viewed.add(file); else viewed.delete(file)
    updateViewedCounter()
    void persistViewed()
  }
  const updateViewedCounter = (): void => {
    if (deps.totalFiles() === 0) { deps.viewedCounterEl.classList.add('hidden'); return }
    const done = getViewedFiles().size
    deps.viewedCounterEl.textContent = reviewT('reviewedCount', { done, total: deps.totalFiles() })
    deps.viewedCounterEl.classList.remove('hidden')
  }

  // ── Resolved comments ─────────────────────────────────────────────────────
  // Del mismo almacén que los archivos revisados: la marca es tuya —GitHub no
  // tiene dónde guardarla para un comentario suelto— pero tiene que seguirte
  // de un cliente a otro. En el navegador, la CLI y el móvil no la veían.
  let resolved = new Set<number>()
  const resolvedKey = (): string => `bento.review.resolved.${deps.repoPath()}.${deps.currentPrNumber() ?? ''}`
  const getResolvedComments = (): Set<number> => resolved

  const loadResolvedComments = async (): Promise<void> => {
    const cwd = deps.repoPath()
    const pr = deps.currentPrNumber()
    if (!cwd || pr === null) { resolved = new Set(); return }
    resolved = new Set(await invoke<number[]>('review_resolved_get', { cwd, pr }).catch(() => []))
    // Lo que guardaba el navegador antes de que hubiera almacén: se mueve una
    // vez y se borra de ahí, para que desmarcar uno no lo resucite.
    if (!resolved.size) {
      const legacy = readLegacyResolved()
      if (legacy.size) {
        resolved = legacy
        await persistResolved()
        localStorage.removeItem(resolvedKey())
      }
    }
  }

  const readLegacyResolved = (): Set<number> => {
    try { return new Set(JSON.parse(localStorage.getItem(resolvedKey()) ?? '[]') as number[]) }
    catch { return new Set() }
  }

  const persistResolved = async (): Promise<void> => {
    await invoke('review_resolved_set', {
      cwd: deps.repoPath(), pr: deps.currentPrNumber(), ids: [...resolved],
    }).catch(() => {})
  }

  const setCommentResolved = (id: number, resolved_: boolean): void => {
    if (resolved_) resolved.add(id); else resolved.delete(id)
    void persistResolved()
  }

  return {
    getViewedFiles, loadViewedFiles, setFileViewed, updateViewedCounter,
    getResolvedComments, loadResolvedComments, setCommentResolved,
  }
}
