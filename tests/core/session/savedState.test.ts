import { describe, it, expect } from 'vitest'
import { parseSavedState } from '../../../src/core/session/savedState'

describe('parseSavedState', () => {
  it('round-trips the v2 single-workspace shape', () => {
    const state = { schemaVersion: 2, projectPath: '/repo', layout: { panels: ['a'] } }
    expect(parseSavedState(JSON.stringify(state))).toEqual(state)
  })

  it('omits projectPath when absent, keeps the layout', () => {
    expect(parseSavedState(JSON.stringify({ schemaVersion: 2, layout: 42 })))
      .toEqual({ schemaVersion: 2, projectPath: undefined, layout: 42 })
  })

  it('migrates a v1 multi-session blob to the active session layout + project', () => {
    const v1 = {
      schemaVersion: 1,
      sessions: [
        { id: 'session-1', name: 'A', projectPath: '/a' },
        { id: 'session-2', name: 'B', projectPath: '/b' },
      ],
      activeId: 'session-2',
      layouts: { 'session-1': { l: 1 }, 'session-2': { l: 2 } },
    }
    expect(parseSavedState(JSON.stringify(v1)))
      .toEqual({ schemaVersion: 2, projectPath: '/b', layout: { l: 2 } })
  })

  it('falls back to the first session when activeId is missing', () => {
    const v1 = {
      sessions: [{ id: 's1', name: 'A', projectPath: '/a' }],
      layouts: { s1: { l: 1 } },
    }
    expect(parseSavedState(JSON.stringify(v1)))
      .toEqual({ schemaVersion: 2, projectPath: '/a', layout: { l: 1 } })
  })

  it('rejects garbage and non-JSON', () => {
    expect(parseSavedState('{not json')).toBeNull()
    expect(parseSavedState(JSON.stringify({ nope: true }))).toBeNull()
  })
})
