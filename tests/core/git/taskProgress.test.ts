import { describe, it, expect } from 'vitest'
import { taskProgress } from '../../../src/core/git/taskProgress'

describe('taskProgress', () => {
  it('counts clean (no uncommitted changes) and synced (not behind base) worktrees', () => {
    const wts = [{ path: '/a' }, { path: '/b' }, { path: '/c' }]
    const changes = new Map([['/a', 0], ['/b', 5], ['/c', 0]])
    const ab = new Map([
      ['/a', { ahead: 0, behind: 0 }],
      ['/b', { ahead: 1, behind: 2 }],
      ['/c', { ahead: 3, behind: 0 }],
    ])
    expect(taskProgress(wts, changes, ab)).toEqual({
      clean: { done: 2, total: 3 },
      synced: { done: 2, total: 3 },
    })
  })

  it('treats unknown status as clean/synced (data not loaded yet)', () => {
    expect(taskProgress([{ path: '/a' }], new Map(), new Map())).toEqual({
      clean: { done: 1, total: 1 },
      synced: { done: 1, total: 1 },
    })
  })

  it('handles no worktrees', () => {
    expect(taskProgress([], new Map(), new Map())).toEqual({
      clean: { done: 0, total: 0 },
      synced: { done: 0, total: 0 },
    })
  })
})
