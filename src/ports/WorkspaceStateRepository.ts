import type { SavedState } from '../core/session/savedState'

export interface WorkspaceStateRepository {
  load: () => Promise<SavedState | null>
  save: (state: SavedState) => Promise<void>
}
