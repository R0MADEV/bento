import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'
import { parseSavedState, type SavedState } from '../core/session/savedState'

const KEY = 'bento.workspace.state'

export class LocalStorageWorkspaceStateRepository implements WorkspaceStateRepository {
  async load(): Promise<SavedState | null> {
    const raw = localStorage.getItem(KEY)
    return raw ? parseSavedState(raw) : null
  }

  async save(state: SavedState): Promise<void> {
    localStorage.setItem(KEY, JSON.stringify(state))
  }
}
