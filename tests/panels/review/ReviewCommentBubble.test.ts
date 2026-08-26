// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildReviewCommentBubble, buildReviewLineForm, type ReviewCommentActions, type ReviewLineFormActions } from '../../../src/panels/review/ReviewCommentBubble'
import type { GhComment } from '../../../src/panels/review/reviewFormat'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
}

const comment: GhComment = { id: 1, path: 'src/a.ts', line: 3, body: 'hello', user: { login: 'alice' }, html_url: '' }

describe('buildReviewCommentBubble', () => {
  it('renders author and body', () => {
    setup()
    const actions: ReviewCommentActions = {
      repoPath: () => '/repo',
      currentPrNumber: () => 42,
      isResolved: () => false,
      setResolved: vi.fn(),
      refresh: vi.fn(async () => {}),
    }
    const bubble = buildReviewCommentBubble(comment, actions)
    expect(bubble.querySelector('.review-comment-author')?.textContent).toBe('alice')
    expect(bubble.querySelector('.review-existing-comment-body')?.textContent).toBe('hello')
    expect(bubble.classList.contains('review-existing-comment--resolved')).toBe(false)
  })

  it('toggles resolved state through the resolve button', () => {
    setup()
    const setResolved = vi.fn()
    let resolved = false
    const actions: ReviewCommentActions = {
      repoPath: () => '/repo',
      currentPrNumber: () => 42,
      isResolved: () => resolved,
      setResolved: (id, value) => { resolved = value; setResolved(id, value) },
      refresh: vi.fn(async () => {}),
    }
    const bubble = buildReviewCommentBubble(comment, actions)
    const resolveBtn = bubble.querySelector<HTMLButtonElement>('.review-resolve-btn')!
    resolveBtn.click()
    expect(setResolved).toHaveBeenCalledWith(1, true)
    expect(bubble.classList.contains('review-existing-comment--resolved')).toBe(true)
  })

  it('saves an edit through gh_pr_update_comment and refreshes', async () => {
    setup()
    const refresh = vi.fn(async () => {})
    const actions: ReviewCommentActions = { repoPath: () => '/repo', currentPrNumber: () => 42, isResolved: () => false, setResolved: vi.fn(), refresh }
    const bubble = buildReviewCommentBubble(comment, actions)
    bubble.querySelectorAll<HTMLButtonElement>('.review-comment-action-btn')[0].click()
    const textarea = bubble.querySelector<HTMLTextAreaElement>('.review-edit-wrap textarea')!
    textarea.value = 'updated body'
    bubble.querySelector<HTMLButtonElement>('.review-edit-wrap .review-comment-btn')!.click()
    await new Promise(r => setTimeout(r, 0))
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_update_comment', { path: '/repo', prNumber: 42, commentId: 1, body: 'updated body' })
    expect(refresh).toHaveBeenCalled()
  })

  it('deletes after confirm through gh_pr_delete_comment and refreshes', async () => {
    setup()
    vi.stubGlobal('confirm', vi.fn(() => true))
    const refresh = vi.fn(async () => {})
    const actions: ReviewCommentActions = { repoPath: () => '/repo', currentPrNumber: () => 42, isResolved: () => false, setResolved: vi.fn(), refresh }
    const bubble = buildReviewCommentBubble(comment, actions)
    bubble.querySelector<HTMLButtonElement>('.review-comment-delete-btn')!.click()
    await new Promise(r => setTimeout(r, 0))
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_delete_comment', { path: '/repo', prNumber: 42, commentId: 1 })
    expect(refresh).toHaveBeenCalled()
  })

  it('does not delete when the confirm dialog is dismissed', async () => {
    setup()
    vi.stubGlobal('confirm', vi.fn(() => false))
    const refresh = vi.fn(async () => {})
    const actions: ReviewCommentActions = { repoPath: () => '/repo', currentPrNumber: () => 42, isResolved: () => false, setResolved: vi.fn(), refresh }
    const bubble = buildReviewCommentBubble(comment, actions)
    bubble.querySelector<HTMLButtonElement>('.review-comment-delete-btn')!.click()
    await new Promise(r => setTimeout(r, 0))
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('buildReviewLineForm', () => {
  function makeActions(overrides: Partial<ReviewLineFormActions> = {}): ReviewLineFormActions {
    return {
      repoPath: () => '/repo',
      selectedBranch: () => 'feat/x',
      currentPrNumber: () => 42,
      refresh: vi.fn(async () => {}),
      showSentLink: vi.fn(),
      ...overrides,
    }
  }

  it('restores a saved draft for the file/line', () => {
    setup()
    localStorage.setItem('bento.review.draft./repo.feat/x.src/a.ts.5', 'draft text')
    const form = buildReviewLineForm('src/a.ts', 5, undefined, makeActions())
    expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('draft text')
  })

  it('persists typed text as a draft and clears it when emptied', () => {
    setup()
    const form = buildReviewLineForm('src/a.ts', 5, undefined, makeActions())
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'work in progress'
    textarea.dispatchEvent(new Event('input'))
    expect(localStorage.getItem('bento.review.draft./repo.feat/x.src/a.ts.5')).toBe('work in progress')
    textarea.value = ''
    textarea.dispatchEvent(new Event('input'))
    expect(localStorage.getItem('bento.review.draft./repo.feat/x.src/a.ts.5')).toBeNull()
  })

  it('blocks sending when there is no PR for the branch', async () => {
    setup()
    const actions = makeActions({ currentPrNumber: () => null })
    const form = buildReviewLineForm('src/a.ts', 5, undefined, actions)
    form.querySelector<HTMLTextAreaElement>('textarea')!.value = 'a comment'
    form.querySelector<HTMLButtonElement>('.review-comment-btn')!.click()
    await new Promise(r => setTimeout(r, 0))
    expect(form.querySelector('.review-comment-status')?.textContent).toBe('No PR for this branch')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('sends an inline comment, clears the draft, and reports the link', async () => {
    setup()
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_rev_parse') return 'commit123'
      if (cmd === 'gh_pr_inline_comment') return 'https://example.com/pr/1'
      return undefined
    })
    const actions = makeActions()
    const form = buildReviewLineForm('src/a.ts', 5, 3, actions)
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = 'a comment'
    textarea.dispatchEvent(new Event('input'))
    form.querySelector<HTMLButtonElement>('.review-comment-btn')!.click()
    await new Promise(r => setTimeout(r, 0))

    expect(mocks.invoke).toHaveBeenCalledWith('git_rev_parse', { path: '/repo', reference: 'feat/x' })
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_inline_comment', {
      path: '/repo', prNumber: 42, commitId: 'commit123', file: 'src/a.ts', line: 5, startLine: 3, body: 'a comment',
    })
    expect(localStorage.getItem('bento.review.draft./repo.feat/x.src/a.ts.5')).toBeNull()
    expect(actions.showSentLink).toHaveBeenCalledWith(expect.anything(), 'https://example.com/pr/1')
    expect(actions.refresh).toHaveBeenCalled()
  })
})
