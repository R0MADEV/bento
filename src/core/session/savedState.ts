// The persisted workspace: a single layout + optional bound project folder.
// v1 (multi-session: sessions[]/activeId/layouts{}) is migrated on read by
// collapsing to the previously-active session's layout + project.
export interface SavedState {
  schemaVersion: 2
  projectPath?: string
  layout: unknown
}

// Validates the state read from disk (trust boundary): returns null if it isn't
// a shape we recognise; migrates the old multi-session format to a single layout.
export function parseSavedState(raw: string): SavedState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  if (obj.schemaVersion === 2) {
    const projectPath = typeof obj.projectPath === 'string' ? obj.projectPath : undefined
    return { schemaVersion: 2, projectPath, layout: obj.layout }
  }

  // Legacy v1 multi-session: collapse to the active (or first) session.
  if (Array.isArray(obj.sessions)) {
    const sessions = obj.sessions as Array<Record<string, unknown>>
    const activeId = typeof obj.activeId === 'string' ? obj.activeId : undefined
    const active = sessions.find(s => s.id === activeId) ?? sessions[0]
    const layouts = (typeof obj.layouts === 'object' && obj.layouts !== null)
      ? obj.layouts as Record<string, unknown>
      : {}
    const id = active && typeof active.id === 'string' ? active.id : undefined
    const projectPath = active && typeof active.projectPath === 'string' ? active.projectPath : undefined
    return { schemaVersion: 2, projectPath, layout: id ? layouts[id] : undefined }
  }

  return null
}
