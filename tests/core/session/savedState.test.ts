import { describe, it, expect } from 'vitest'
import { parseSavedState } from '../../../src/core/session/savedState'

describe('parseSavedState', () => {
  it('parses a valid state', () => {
    const raw = JSON.stringify({
      sessions: [{ id: 'session-1', name: 'Sesión 1' }],
      activeId: 'session-1',
      layouts: { 'session-1': { foo: 'bar' } },
    })
    expect(parseSavedState(raw)).toEqual({
      sessions: [{ id: 'session-1', name: 'Sesión 1' }],
      activeId: 'session-1',
      layouts: { 'session-1': { foo: 'bar' } },
    })
  })

  it('defaults layouts to an empty object when missing', () => {
    const raw = JSON.stringify({ sessions: [{ id: 's', name: 'S' }], activeId: 's' })
    expect(parseSavedState(raw)?.layouts).toEqual({})
  })

  it('returns null for invalid JSON', () => {
    expect(parseSavedState('{not json')).toBeNull()
  })

  it('returns null when sessions is missing or not an array', () => {
    expect(parseSavedState('{}')).toBeNull()
    expect(parseSavedState(JSON.stringify({ sessions: 'x' }))).toBeNull()
  })

  it('returns null when a session lacks id or name', () => {
    expect(parseSavedState(JSON.stringify({ sessions: [{ id: 'x' }] }))).toBeNull()
  })
})
