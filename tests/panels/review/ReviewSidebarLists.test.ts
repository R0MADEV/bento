// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => [] as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildReviewSidebarLists, type ReviewSidebarState } from '../../../src/panels/review/ReviewSidebarLists'
import type { GhPr, SidebarMode } from '../../../src/panels/review/reviewFormat'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue([])
}

function makeRefs() {
  return {
    branchSearch: Object.assign(document.createElement('input'), { type: 'text' }),
    branchList: document.createElement('div'),
    prList: document.createElement('div'),
    branchesTab: document.createElement('button'),
    prsTab: document.createElement('button'),
    branchInput: Object.assign(document.createElement('input'), { type: 'text' }),
    branchDropdown: document.createElement('div'),
  }
}

interface Harness {
  refs: ReturnType<typeof makeRefs>
  state: ReviewSidebarState
  data: {
    repoPath: string
    allBranches: string[]
    selectedBranch: string
    baseBranch: string
    sidebarMode: SidebarMode
    openPrs: GhPr[]
    currentPrNumber: number | null
  }
  selectBranch: ReturnType<typeof vi.fn>
  loadDiff: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<Harness['data']> = {}): Harness {
  const refs = makeRefs()
  const data: Harness['data'] = {
    repoPath: '/repo',
    allBranches: ['origin/main', 'origin/feat/login', 'origin/feat/payments'],
    selectedBranch: '',
    baseBranch: 'origin/main',
    sidebarMode: 'branches',
    openPrs: [],
    currentPrNumber: null,
    ...overrides,
  }
  const selectBranch = vi.fn()
  const loadDiff = vi.fn()
  const state: ReviewSidebarState = {
    repoPath: () => data.repoPath,
    allBranches: () => data.allBranches,
    selectedBranch: () => data.selectedBranch,
    baseBranch: () => data.baseBranch,
    setBaseBranch: value => { data.baseBranch = value },
    sidebarMode: () => data.sidebarMode,
    setSidebarModeState: mode => { data.sidebarMode = mode },
    openPrs: () => data.openPrs,
    setOpenPrs: prs => { data.openPrs = prs },
    currentPrNumber: () => data.currentPrNumber,
    selectBranch,
    loadDiff,
  }
  return { refs, state, data, selectBranch, loadDiff }
}

describe('renderBranchList', () => {
  it('lists all branches and marks the selected one active', () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/main' })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.renderBranchList()
    const items = h.refs.branchList.querySelectorAll('.review-branch-item')
    expect(items).toHaveLength(3)
    expect([...items].find(i => i.textContent === 'origin/main')?.classList.contains('review-branch-item--active')).toBe(true)
  })

  it('filters by the search input and selects on click', () => {
    setup()
    const h = makeHarness()
    const lists = buildReviewSidebarLists(h.refs, h.state)
    h.refs.branchSearch.value = 'login'
    lists.renderBranchList()
    const items = h.refs.branchList.querySelectorAll<HTMLElement>('.review-branch-item')
    expect(items).toHaveLength(1)
    items[0].click()
    expect(h.selectBranch).toHaveBeenCalledWith('origin/feat/login')
  })

  it('re-renders through the search input event, routed by sidebar mode', () => {
    setup()
    const h = makeHarness()
    buildReviewSidebarLists(h.refs, h.state)
    h.refs.branchSearch.value = 'payments'
    h.refs.branchSearch.dispatchEvent(new Event('input'))
    expect(h.refs.branchList.querySelectorAll('.review-branch-item')).toHaveLength(1)
  })
})

describe('renderPrList', () => {
  const prs: GhPr[] = [
    { number: 1, title: 'Fix login', url: '', headRefName: 'feat/login', baseRefName: 'main', author: { login: 'alice' } },
    { number: 2, title: 'Add payments', url: '', headRefName: 'feat/payments', baseRefName: 'main', author: { login: 'bob' } },
  ]

  it('shows an empty message when there are no PRs at all', () => {
    setup()
    const h = makeHarness()
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.renderPrList()
    expect(h.refs.prList.querySelector('.review-pr-list-empty')?.textContent).toBeTruthy()
  })

  it('shows a no-match message when the search filters everything out', () => {
    setup()
    const h = makeHarness({ openPrs: prs })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    h.refs.branchSearch.value = 'nonexistent'
    lists.renderPrList()
    expect(h.refs.prList.querySelectorAll('.review-pr-item')).toHaveLength(0)
    expect(h.refs.prList.querySelector('.review-pr-list-empty')).not.toBeNull()
  })

  it('renders matching PRs and marks the current one active', () => {
    setup()
    const h = makeHarness({ openPrs: prs, currentPrNumber: 2 })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.renderPrList()
    const items = h.refs.prList.querySelectorAll('.review-pr-item')
    expect(items).toHaveLength(2)
    expect(items[1].classList.contains('review-pr-item--active')).toBe(true)
  })

  it('selecting a PR resolves head/base branches and updates base branch', () => {
    setup()
    const h = makeHarness({ openPrs: prs })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.renderPrList()
    h.refs.prList.querySelectorAll<HTMLElement>('.review-pr-item')[0].click()
    expect(h.data.baseBranch).toBe('origin/main')
    expect(h.selectBranch).toHaveBeenCalledWith('origin/feat/login')
  })
})

describe('loadPrList', () => {
  it('does nothing without a repo path', async () => {
    setup()
    const h = makeHarness({ repoPath: '' })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    await lists.loadPrList()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('fetches and stores open PRs', async () => {
    setup()
    const prs: GhPr[] = [{ number: 5, title: 'X', url: '', headRefName: 'x', baseRefName: 'main', author: { login: 'a' } }]
    mocks.invoke.mockResolvedValue(prs)
    const h = makeHarness()
    const lists = buildReviewSidebarLists(h.refs, h.state)
    await lists.loadPrList()
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_list_open', { path: '/repo' })
    expect(h.data.openPrs).toEqual(prs)
  })

  it('clears the PR list on failure instead of throwing', async () => {
    setup()
    mocks.invoke.mockRejectedValue(new Error('boom'))
    const h = makeHarness({ openPrs: [{ number: 1, title: 'x', url: '', headRefName: 'x', baseRefName: 'main', author: { login: 'a' } }] })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    await expect(lists.loadPrList()).resolves.toBeUndefined()
    expect(h.data.openPrs).toEqual([])
  })
})

describe('setSidebarMode', () => {
  it('toggles tab/list visibility and loads PRs on first switch to prs', () => {
    setup()
    const h = makeHarness()
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.setSidebarMode('prs')
    expect(h.data.sidebarMode).toBe('prs')
    expect(h.refs.branchesTab.classList.contains('review-tab--active')).toBe(false)
    expect(h.refs.prsTab.classList.contains('review-tab--active')).toBe(true)
    expect(h.refs.branchList.classList.contains('hidden')).toBe(true)
    expect(h.refs.prList.classList.contains('hidden')).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_list_open', { path: '/repo' })
  })

  it('does not refetch PRs when some are already loaded', () => {
    setup()
    const h = makeHarness({ openPrs: [{ number: 1, title: 'x', url: '', headRefName: 'x', baseRefName: 'main', author: { login: 'a' } }] })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.setSidebarMode('prs')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('renderBaseDropdown', () => {
  it('filters branches by the base input and hides when nothing matches', () => {
    setup()
    const h = makeHarness()
    const lists = buildReviewSidebarLists(h.refs, h.state)
    h.refs.branchInput.value = 'zzz'
    lists.renderBaseDropdown()
    expect(h.refs.branchDropdown.classList.contains('hidden')).toBe(true)
  })

  it('selecting an option sets the base branch and reloads the diff when a branch is active', () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat/login' })
    const lists = buildReviewSidebarLists(h.refs, h.state)
    lists.renderBaseDropdown()
    const option = h.refs.branchDropdown.querySelector<HTMLElement>('.review-branch-option')!
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(h.data.baseBranch).toBe('origin/main')
    expect(h.loadDiff).toHaveBeenCalled()
  })

  it('pressing Enter normalizes colon syntax into the base branch', () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat/login', baseBranch: 'origin/develop' })
    buildReviewSidebarLists(h.refs, h.state)
    h.refs.branchInput.value = 'origin:main'
    h.refs.branchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(h.refs.branchInput.value).toBe('origin/main')
    expect(h.data.baseBranch).toBe('origin/main')
    expect(h.loadDiff).toHaveBeenCalled()
  })
})
