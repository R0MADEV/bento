// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
import { makeLocalStorage } from '../../helpers/localStorage'
import { createReviewPanel, describeReviewNoBranchChanges, describeReviewPrState, filterReviewPrs } from '../../../src/panels/review/ReviewPanel'

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

  it('puts the report next to the diff instead of on top of it', () => {
    setup()
    const { element } = createReviewPanel()
    const drawer = element.querySelector('.review-drawer')

    // The third column: a sibling of the diff inside the same row, not an
    // overlay laid over it. As an overlay it covered the code the findings
    // point at, which is what you read them against.
    expect(drawer?.parentElement?.className).toBe('review-body')
    expect(drawer?.previousElementSibling?.className).toBe('review-detail')
  })

  it('lists every saved review of the project, not only the last one', async () => {
    setup()
    const metas = [
      { base: 'main', saved_at: '2026-08-27T09:00:00Z', branch: 'feat/x', run_id: 'run-1', resumable: true },
      { base: 'main', saved_at: '2026-08-27T10:00:00Z', branch: 'feat/y', run_id: 'run-2', resumable: false },
    ]
    // Los demás comandos del panel devuelven listas: el panel arranca cargando
    // ramas en cuanto tiene repo.
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'review_checkpoints_list' ? metas : []))
    const { element } = createReviewPanel('/repo')

    element.querySelector<HTMLButtonElement>('.review-history-btn')!.click()
    await vi.waitFor(() =>
      expect(element.querySelectorAll('.review-history-row')).toHaveLength(2))

    // Every client stamps a run id now, so a branch keeps every review. This
    // app saved them and could reach none but the newest.
    const rows = element.querySelectorAll('.review-history-open')
    expect(rows[0]?.textContent).toContain('feat/x')
    expect(rows[1]?.textContent).toContain('feat/y')
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

  it('describes merged PRs explicitly', () => {
    expect(describeReviewPrState('MERGED', '2026-08-14T00:00:00Z')).toMatchObject({
      text: 'Merged',
      cls: 'review-pr-state--merged',
    })
  })

  it('describes merged branches without the generic no-changes copy', () => {
    // Comprueba la copia en inglés, así que fija el idioma en vez de heredar el
    // que dejara el test anterior.
    setup()
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
