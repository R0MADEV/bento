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

  it('renders sidebar and detail panes', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.cs-sidebar')).not.toBeNull()
    expect(element.querySelector('.review-detail')).not.toBeNull()
  })

  it('comment bar hidden until PR is loaded', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-comment-bar')?.classList.contains('hidden')).toBe(true)
  })

  it('renders branch search input in sidebar', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-branch-search')).not.toBeNull()
  })
})
