// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { createReviewPanel } from '../../../src/panels/review/ReviewPanel'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
}

describe('ReviewPanel', () => {
  it('renders root with review-panel class', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.classList.contains('review-panel')).toBe(true)
  })

  it('shows empty state when no repo', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-empty-state')?.classList.contains('hidden')).toBe(false)
  })

  it('has open-repo button in empty state', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-empty-open-btn')?.textContent).toContain('Open repo')
  })

  it('renders refresh button', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-refresh-btn')).not.toBeNull()
  })

  it('renders commit bar hidden by default (branch mode)', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-commit-bar')?.classList.contains('hidden')).toBe(true)
  })

  it('branch mode button is active by default', () => {
    setup()
    const { element } = createReviewPanel()
    const [branchBtn] = element.querySelectorAll<HTMLButtonElement>('.review-mode-btn')
    expect(branchBtn?.classList.contains('review-mode-btn--active')).toBe(true)
  })

  it('clicking worktree mode shows commit bar', () => {
    setup()
    const { element } = createReviewPanel()
    const [, worktreeBtn] = element.querySelectorAll<HTMLButtonElement>('.review-mode-btn')
    worktreeBtn?.click()
    expect(element.querySelector('.review-commit-bar')?.classList.contains('hidden')).toBe(false)
  })
})
