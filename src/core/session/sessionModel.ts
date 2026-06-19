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
