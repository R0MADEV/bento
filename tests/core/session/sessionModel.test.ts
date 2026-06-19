import { describe, it, expect } from 'vitest'
import { addSession, removeSession, setActiveSession, type SessionState } from '../../../src/core/session/sessionModel'

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
})
