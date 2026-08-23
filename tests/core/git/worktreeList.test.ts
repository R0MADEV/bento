import { describe, expect, it } from 'vitest'
import { filterWorktrees, groupWorktreesByRepo } from '../../../src/core/git/worktreeList'
import type { Worktree } from '../../../src/core/git/worktree'

const wt = (over: Partial<Worktree> = {}): Worktree =>
  ({ path: '/repo/wt', branch: 'main', head: 'abc', ...over } as Worktree)

const paths = (rows: Worktree[]): string[] => rows.map(r => r.path)

const TREES = [
  wt({ path: '/repo/feature-login', branch: 'feat/login' }),
  wt({ path: '/repo/fix-redirect', branch: 'fix/redirect' }),
  wt({ path: '/other/main', branch: 'main' }),
]

describe('filterWorktrees', () => {
  it('returns everything for an empty query', () => {
    expect(filterWorktrees(TREES, '')).toEqual(TREES)
    expect(filterWorktrees(TREES, '   ')).toEqual(TREES)
  })

  it('matches the branch name, case-insensitively', () => {
    expect(paths(filterWorktrees(TREES, 'LOGIN'))).toEqual(['/repo/feature-login'])
  })

  it('matches the path too', () => {
    expect(paths(filterWorktrees(TREES, '/other'))).toEqual(['/other/main'])
  })

  it('keeps a detached worktree out of a branch search instead of throwing', () => {
    const detached = [wt({ path: '/repo/detached', branch: undefined })]
    expect(filterWorktrees(detached, 'main')).toEqual([])
    expect(paths(filterWorktrees(detached, 'detached'))).toEqual(['/repo/detached'])
  })

  it('can match nothing', () => {
    expect(filterWorktrees(TREES, 'nothing here')).toEqual([])
  })

  it('preserves the original order', () => {
    expect(paths(filterWorktrees(TREES, 'e'))).toEqual(paths(TREES.filter(t =>
      t.path.includes('e') || (t.branch ?? '').includes('e'))))
  })
})

describe('groupWorktreesByRepo', () => {
  const repoOf = new Map([
    ['/repo/feature-login', '/repo'],
    ['/repo/fix-redirect', '/repo'],
    ['/other/main', '/other'],
  ])

  it('buckets each worktree under its repo', () => {
    const groups = groupWorktreesByRepo(TREES, repoOf, '/fallback')
    expect([...groups.keys()]).toEqual(['/repo', '/other'])
    expect(paths(groups.get('/repo')!)).toEqual(['/repo/feature-login', '/repo/fix-redirect'])
  })

  it('falls back for a worktree with no recorded repo', () => {
    const groups = groupWorktreesByRepo([wt({ path: '/stray' })], new Map(), '/fallback')
    expect([...groups.keys()]).toEqual(['/fallback'])
  })

  it('keeps repos in the order they first appear', () => {
    const reversed = [TREES[2], TREES[0]]
    expect([...groupWorktreesByRepo(reversed, repoOf, '/fallback').keys()]).toEqual(['/other', '/repo'])
  })

  it('keeps the worktree order inside each repo', () => {
    const groups = groupWorktreesByRepo([TREES[1], TREES[0]], repoOf, '/fallback')
    expect(paths(groups.get('/repo')!)).toEqual(['/repo/fix-redirect', '/repo/feature-login'])
  })

  it('groups nothing into nothing', () => {
    expect(groupWorktreesByRepo([], repoOf, '/fallback').size).toBe(0)
  })
})
