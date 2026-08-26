import { describe, it, expect } from 'vitest'
import { addRepo, removeRepo } from '../../../src/core/git/repoList'

describe('addRepo', () => {
  it('appends new repos, normalizing the trailing slash', () => {
    expect(addRepo([], '/a/')).toEqual(['/a'])
    expect(addRepo(['/a'], '/b')).toEqual(['/a', '/b'])
  })
  it('dedups an already-present repo', () => {
    expect(addRepo(['/a'], '/a/')).toEqual(['/a'])
  })
  it('ignores empty paths', () => {
    expect(addRepo(['/a'], '  ')).toEqual(['/a'])
  })
})

describe('removeRepo', () => {
  it('removes a repo, normalizing the trailing slash', () => {
    expect(removeRepo(['/a', '/b'], '/a/')).toEqual(['/b'])
  })
  it('is a no-op when the repo is not present', () => {
    expect(removeRepo(['/a'], '/x')).toEqual(['/a'])
  })
})
