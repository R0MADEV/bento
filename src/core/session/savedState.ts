import type { Session } from './sessionModel'

export interface SavedState {
  schemaVersion: number
  sessions: Session[]
  activeId: string | null
  layouts: Record<string, unknown>
}

function isSession(v: unknown): v is Session {
  return typeof v === 'object' && v !== null
    && typeof (v as Session).id === 'string'
    && typeof (v as Session).name === 'string'
}

// Validates the state read from disk (trust boundary): returns null if it isn't valid.
export function parseSavedState(raw: string): SavedState | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null) return null
  const obj = data as Record<string, unknown>

  if (!Array.isArray(obj.sessions) || !obj.sessions.every(isSession)) return null

  const layouts = typeof obj.layouts === 'object' && obj.layouts !== null
    ? (obj.layouts as Record<string, unknown>)
    : {}
  const activeId = typeof obj.activeId === 'string' ? obj.activeId : null

  const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 1) return null

  return { schemaVersion, sessions: obj.sessions, activeId, layouts }
}
