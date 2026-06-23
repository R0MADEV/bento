import { describe, it, expect } from 'vitest'
import { addSession, removeSession, setActiveSession, renameSession, duplicateSession, type SessionState } from '../../../src/core/session/sessionModel'

const empty: SessionState = { sessions: [], activeId: null }

describe('sessionModel', () => {
  it('addSession creates a session and activates it', () => {
    const s = addSession(empty)
    expect(s.sessions).toHaveLength(1)
    expect(s.activeId).toBe(s.sessions[0].id)
  })

  it('addSession reuses the lowest free number', () => {
    const two = addSession(addSession(empty))
    const afterRemove = removeSession(two, two.sessions[0].id)
    const readded = addSession(afterRemove)
    expect(readded.sessions.map(s => s.id)).toContain('session-1')
  })

  it('removeSession removes it and activates another', () => {
    const two = addSession(addSession(empty))
    const s = removeSession(two, two.sessions[0].id)
    expect(s.sessions).toHaveLength(1)
    expect(s.activeId).toBe(s.sessions[0].id)
  })

  it('removeSession of the last leaves none active', () => {
    const one = addSession(empty)
    const s = removeSession(one, one.sessions[0].id)
    expect(s.sessions).toHaveLength(0)
    expect(s.activeId).toBeNull()
  })

  it('setActiveSession switches the active one', () => {
    const two = addSession(addSession(empty))
    const s = setActiveSession(two, two.sessions[0].id)
    expect(s.activeId).toBe(two.sessions[0].id)
  })

  it('setActiveSession ignores unknown ids', () => {
    const one = addSession(empty)
    expect(setActiveSession(one, 'session-999')).toEqual(one)
  })

  it('renameSession updates the name of the matching session', () => {
    const one = addSession(empty)
    const id = one.sessions[0].id
    const s = renameSession(one, id, 'Mi sesión')
    expect(s.sessions[0].name).toBe('Mi sesión')
    expect(s.activeId).toBe(one.activeId)
  })

  it('renameSession does not affect other sessions', () => {
    const two = addSession(addSession(empty))
    const [a, b] = two.sessions
    const s = renameSession(two, a.id, 'Renombrada')
    expect(s.sessions.find(x => x.id === b.id)?.name).toBe(b.name)
  })

  it('renameSession with unknown id returns state unchanged', () => {
    const one = addSession(empty)
    expect(renameSession(one, 'session-999', 'X')).toEqual(one)
  })

  it('duplicateSession creates a copy with "(copia)" suffix and activates it', () => {
    const one = addSession(empty)
    const s = duplicateSession(one, one.sessions[0].id)
    expect(s.sessions).toHaveLength(2)
    expect(s.sessions[1].name).toBe('Sesión 1 (copia)')
    expect(s.activeId).toBe(s.sessions[1].id)
  })

  it('duplicateSession assigns the lowest available number', () => {
    const two = addSession(addSession(empty))
    const s = duplicateSession(two, two.sessions[0].id)
    expect(s.sessions[2].id).toBe('session-3')
  })

  it('duplicateSession with unknown id returns state unchanged', () => {
    const one = addSession(empty)
    expect(duplicateSession(one, 'session-999')).toEqual(one)
  })
})
