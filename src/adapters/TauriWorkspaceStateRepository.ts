import { invoke } from '@tauri-apps/api/core'
import { parseSavedState, type SavedState } from '../core/session/savedState'
import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'

const LEGACY_KEY = 'bento.workspace.state'

function validState(value: unknown): SavedState | null {
  return parseSavedState(JSON.stringify(value))
}

export class TauriWorkspaceStateRepository implements WorkspaceStateRepository {
  async load(): Promise<SavedState | null> {
    const stored = validState(await invoke<SavedState | null>('workspace_load'))
    if (stored) return stored

    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    const legacy = legacyRaw ? parseSavedState(legacyRaw) : null
    if (!legacy) return null
    await this.save(legacy)
    localStorage.removeItem(LEGACY_KEY)
    return legacy
  }

  async save(state: SavedState): Promise<void> {
    await invoke('workspace_save', { state })
  }
}
