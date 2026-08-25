// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { buildReviewLocalState } from '../../../src/panels/review/reviewLocalState'

function setup(overrides: { repoPath?: string; branch?: string; pr?: number | null; total?: number } = {}) {
  const viewedCounterEl = document.createElement('span')
  const state = buildReviewLocalState({
    repoPath: () => overrides.repoPath ?? '/repo',
    selectedBranch: () => overrides.branch ?? 'feat/a',
    currentPrNumber: () => overrides.pr ?? 10,
    totalFiles: () => overrides.total ?? 3,
    viewedCounterEl,
  })
  return { state, viewedCounterEl }
}

describe('review local state', () => {
  beforeEach(() => {
    globalThis.localStorage = makeLocalStorage() as unknown as Storage
    localStorage.setItem('bento.locale', 'en')
  })

  it('remembers a file marked as viewed', () => {
    const { state } = setup()
    state.setFileViewed('src/a.ts', true)
    expect([...setup().state.getViewedFiles()]).toEqual(['src/a.ts'])
  })

  it('forgets it when unmarked', () => {
    const { state } = setup()
    state.setFileViewed('src/a.ts', true)
    state.setFileViewed('src/a.ts', false)
    expect(setup().state.getViewedFiles().size).toBe(0)
  })

  it('keeps each branch of a repo apart', () => {
    setup({ branch: 'feat/a' }).state.setFileViewed('src/a.ts', true)
    expect(setup({ branch: 'feat/b' }).state.getViewedFiles().size).toBe(0)
  })

  it('keeps each repo apart', () => {
    setup({ repoPath: '/uno' }).state.setFileViewed('src/a.ts', true)
    expect(setup({ repoPath: '/otro' }).state.getViewedFiles().size).toBe(0)
  })

  it('hides the counter when there is nothing to count', () => {
    const { state, viewedCounterEl } = setup({ total: 0 })
    state.updateViewedCounter()
    expect(viewedCounterEl.classList.contains('hidden')).toBe(true)
  })

  it('shows how many of the total are done', () => {
    const { state, viewedCounterEl } = setup({ total: 3 })
    state.setFileViewed('src/a.ts', true)
    expect(viewedCounterEl.classList.contains('hidden')).toBe(false)
    expect(viewedCounterEl.textContent).toMatch(/1.*3/)
  })

  it('remembers a comment marked as resolved, per PR', () => {
    setup({ pr: 10 }).state.setCommentResolved(1, true)
    expect([...setup({ pr: 10 }).state.getResolvedComments()]).toEqual([1])
    expect(setup({ pr: 11 }).state.getResolvedComments().size).toBe(0)
  })

  it('reads corrupt storage as nothing marked instead of throwing', () => {
    localStorage.setItem('bento.review.viewed./repo.feat/a', 'esto no es json')
    expect(setup().state.getViewedFiles().size).toBe(0)
  })
})
