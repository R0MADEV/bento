import { describe, it, expect } from 'vitest'
import { parseWorktreeList, parseStatus, taskBranch, taskPath } from '../../../src/core/git/worktree'

describe('parseWorktreeList', () => {
  it('parses main + feat + detached blocks', () => {
    const raw = [
      'worktree /Users/x/bento',
      'HEAD 9fcea1b',
      'branch refs/heads/main',
      '',
      'worktree /Users/x/bento-login',
      'HEAD 4b2c9d0',
      'branch refs/heads/feat/login',
      '',
      'worktree /Users/x/bento-detached',
      'HEAD 77aa11b',
      'detached',
    ].join('\n')

    expect(parseWorktreeList(raw)).toEqual([
      { path: '/Users/x/bento', branch: 'main', head: '9fcea1b', bare: false },
      { path: '/Users/x/bento-login', branch: 'feat/login', head: '4b2c9d0', bare: false },
      { path: '/Users/x/bento-detached', branch: null, head: '77aa11b', bare: false },
    ])
  })

  it('sets branch null for detached', () => {
    const raw = 'worktree /x/detached\nHEAD abc123\ndetached'
    const [wt] = parseWorktreeList(raw)
    expect(wt.branch).toBeNull()
  })

  it('returns empty for empty input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  it('ignores bare blocks', () => {
    const raw = 'worktree /x/bare.git\nHEAD abc123\nbare'
    expect(parseWorktreeList(raw)).toEqual([])
  })
})

describe('parseStatus', () => {
  it('counts staged, unstaged, untracked and MM correctly', () => {
    const raw = [
      ' M src/a.ts',   // unstaged only
      'M  src/b.ts',   // staged only
      'MM src/c.ts',   // staged + unstaged
      '?? nuevo.ts',   // untracked
      'A  add.ts',     // staged only
    ].join('\n')

    expect(parseStatus(raw)).toEqual({ staged: 3, unstaged: 2, untracked: 1, total: 5 })
  })

  it('returns all zeros for empty input', () => {
    expect(parseStatus('')).toEqual({ staged: 0, unstaged: 0, untracked: 0, total: 0 })
  })
})

describe('taskBranch', () => {
  it('converts "Login Form" to "feat/login-form"', () => {
    expect(taskBranch('Login Form')).toBe('feat/login-form')
  })

  it('converts "fix/BUG 123" to "feat/fix-bug-123"', () => {
    expect(taskBranch('fix/BUG 123')).toBe('feat/fix-bug-123')
  })

  it('collapses consecutive dashes', () => {
    expect(taskBranch('hello--world')).toBe('feat/hello-world')
  })

  it('keeps readable names with accents', () => {
    expect(taskBranch('Añadir conexión')).toBe('feat/anadir-conexion')
  })

  it('trims leading and trailing dashes', () => {
    expect(taskBranch('!!hello!!')).toBe('feat/hello')
  })

  it('falls back to feat/task when result is empty', () => {
    expect(taskBranch('!!!')).toBe('feat/task')
  })
})

describe('taskPath', () => {
  it('appends task name with dash to repo path', () => {
    expect(taskPath('/x/bento', 'login')).toBe('/x/bento-login')
  })

  it('handles trailing slash in repo path', () => {
    expect(taskPath('/x/bento/', 'login')).toBe('/x/bento-login')
  })
})
