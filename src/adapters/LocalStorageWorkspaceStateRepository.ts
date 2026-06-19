import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'
import { parseSavedState, type SavedState } from '../core/session/savedState'

const KEY = 'bento.workspace.state'

export class LocalStorageWorkspaceStateRepository implements WorkspaceStateRepository {
  load(): SavedState | null {
    const raw = localStorage.getItem(KEY)
    return raw ? parseSavedState(raw) : null
  }

  save(state: SavedState): void {
    localStorage.setItem(KEY, JSON.stringify(state))
  }
}
