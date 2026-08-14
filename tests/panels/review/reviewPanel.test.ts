// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { buildReviewFileBatches, buildReviewFileManifest, createReviewPanel, describeReviewNoBranchChanges, describeReviewPrState, filterReviewPrs, resolveReviewFollowUpSession } from '../../../src/panels/review/ReviewPanel'

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

  it('starts with the right review drawer hidden', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-drawer')?.classList.contains('hidden')).toBe(true)
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

  it('hides branches when PRs tab is selected', () => {
    setup()
    const { element } = createReviewPanel()
    element.querySelectorAll<HTMLButtonElement>('.review-tab')[1]?.click()

    expect(element.querySelector('.review-branch-list')?.classList.contains('hidden')).toBe(true)
    expect(element.querySelector('.review-pr-list')?.classList.contains('hidden')).toBe(false)
    expect(element.querySelector('.review-branch-search')?.classList.contains('hidden')).toBe(false)
  })

  it('shows the fixed review agent badge', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('[data-testid="review-agent-badge"]')?.textContent).toBe('Fixed agent: Claude')
  })

  it('shows comparison agent controls when enabled', () => {
    setup()
    const { element } = createReviewPanel()
    const toggle = element.querySelector<HTMLInputElement>('[data-testid="review-compare-agents-toggle"]')!
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))

    expect(element.querySelector('[data-testid="review-secondary-agent"]')?.classList.contains('hidden')).toBe(false)
    expect(element.querySelector('[data-testid="review-agent-badge"]')?.textContent).toContain('Fixed agents:')
  })

  it('shows the agent mode hint', () => {
    setup()
    const { element } = createReviewPanel()
    expect(element.querySelector('.review-agent-hint')?.textContent).toContain('Single agent mode')
  })

  it('keeps follow-up sessions attached to the last real review agent', () => {
    expect(resolveReviewFollowUpSession([
      { label: 'Orchestrator', sessionId: 's1' },
      { label: 'Synthesis', sessionId: 's2' },
      { label: 'Verification', sessionId: 'verifier-session' },
    ].map(run => ({ ...run, agent: 'claude' as const })), 2)).toEqual({ sessionId: 's2', sessionAgent: 'claude' })
  })

  it('builds a complete manifest before batching review files', () => {
    const files = [
      { file: 'src/a.ts', additions: 3, deletions: 1, chunk: 'a'.repeat(6), state: 'M' as const },
      { file: 'src/b.ts', additions: 1, deletions: 0, chunk: 'b'.repeat(6), state: 'D' as const },
    ]

    expect(buildReviewFileManifest(files)).toBe('M src/a.ts (+3/-1)\nD src/b.ts (+1/-0)')
    expect(buildReviewFileBatches(files, 6)).toHaveLength(2)
  })

  it('describes merged PRs explicitly', () => {
    expect(describeReviewPrState('MERGED', '2026-08-14T00:00:00Z')).toMatchObject({
      text: 'Merged',
      cls: 'review-pr-state--merged',
    })
  })

  it('describes merged branches without the generic no-changes copy', () => {
    expect(describeReviewNoBranchChanges('MERGED', 'origin/main')).toBe('Merged PR has no remaining changes vs origin/main')
  })

  it('filters PRs by metadata', () => {
    const prs = [
      { number: 12, title: 'Fix login flow', headRefName: 'feat/login', baseRefName: 'main', author: { login: 'alice' }, state: 'OPEN' },
      { number: 34, title: 'Refactor payments', headRefName: 'feat/pay', baseRefName: 'main', author: { login: 'bob' }, state: 'MERGED' },
    ]

    expect(filterReviewPrs(prs, 'pay')).toHaveLength(1)
    expect(filterReviewPrs(prs, 'alice')).toHaveLength(1)
    expect(filterReviewPrs(prs, 'merged')).toHaveLength(1)
  })
})
