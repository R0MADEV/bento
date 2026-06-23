import { lowestAvailableNumber } from '../terminal/lowestAvailableNumber'

export interface Session {
  id: string
  name: string
}

export interface SessionState {
  sessions: Session[]
  activeId: string | null
}

function sessionNumbers(sessions: Session[]): number[] {
  return sessions.map(s => Number(s.id.slice('session-'.length))).filter(Number.isInteger)
}

export function addSession(state: SessionState): SessionState {
  const n = lowestAvailableNumber(sessionNumbers(state.sessions))
  const session: Session = { id: `session-${n}`, name: `Sesión ${n}` }
  return { sessions: [...state.sessions, session], activeId: session.id }
}

export function removeSession(state: SessionState, id: string): SessionState {
  const sessions = state.sessions.filter(s => s.id !== id)
  const stillActive = sessions.some(s => s.id === state.activeId)
  const activeId = stillActive ? state.activeId : (sessions.at(-1)?.id ?? null)
  return { sessions, activeId }
}

export function setActiveSession(state: SessionState, id: string): SessionState {
  return state.sessions.some(s => s.id === id) ? { ...state, activeId: id } : state
}

export function renameSession(state: SessionState, id: string, name: string): SessionState {
  const sessions = state.sessions.map(s => s.id === id ? { ...s, name } : s)
  return { ...state, sessions }
}

export function duplicateSession(state: SessionState, id: string): SessionState {
  const source = state.sessions.find(s => s.id === id)
  if (!source) return state
  const n = lowestAvailableNumber(sessionNumbers(state.sessions))
  const copy: Session = { id: `session-${n}`, name: `${source.name} (copia)` }
  return { sessions: [...state.sessions, copy], activeId: copy.id }
}
