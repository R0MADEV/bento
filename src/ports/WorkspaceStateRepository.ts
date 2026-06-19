import type { SavedState } from '../core/session/savedState'

export interface WorkspaceStateRepository {
  load: () => SavedState | null
  save: (state: SavedState) => void
}
