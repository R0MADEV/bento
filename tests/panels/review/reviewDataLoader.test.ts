// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  pickFolder: vi.fn(async () => null as string | null),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.pickFolder }))

import { buildReviewDataLoader, type ReviewDataLoaderState, type StatusRollupEntry } from '../../../src/panels/review/reviewDataLoader'
import type { ReviewChangeFile, GhComment, GhPr, SidebarMode, FileTypeFilter } from '../../../src/panels/review/reviewFormat'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.pickFolder.mockReset()
  mocks.pickFolder.mockResolvedValue(null)
}

function makeDom() {
  return {
    filterBar: document.createElement('div'),
    diffSearchInput: Object.assign(document.createElement('input'), { type: 'search' }) as HTMLInputElement,
    diffView: document.createElement('div'),
    prMetaEl: document.createElement('div'),
    prBodyEl: document.createElement('div'),
    discussionEl: document.createElement('div'),
    commentBar: document.createElement('div'),
    branchInput: Object.assign(document.createElement('input'), { type: 'text' }) as HTMLInputElement,
    viewedCounterEl: document.createElement('span'),
    commentNavWrap: document.createElement('div'),
    commentInput: document.createElement('textarea') as unknown as HTMLTextAreaElement,
    approveBtn: document.createElement('button') as HTMLButtonElement,
    requestChangesBtn: document.createElement('button') as HTMLButtonElement,
  }
}

interface Data {
  repoPath: string
  baseBranch: string
  selectedBranch: string
  activeLocalBranch: string
  allBranches: string[]
  currentPrNumber: number | null
  existingComments: GhComment[]
  loadingBranch: string
  sidebarMode: SidebarMode
  openPrs: GhPr[]
  fileTypeFilter: FileTypeFilter
  totalFiles: number
  lastFiles: ReviewChangeFile[]
  lastStatusRollup: StatusRollupEntry[]
  resolvedComments: Set<number>
  discSeq: number
  prInfoSeq: number
  currentPrTitle: string
  currentPrBody: string
  currentPrState: string | null
}

interface Harness {
  dom: ReturnType<typeof makeDom>
  data: Data
  state: ReviewDataLoaderState
  renderBranchList: ReturnType<typeof vi.fn>
  renderPrList: ReturnType<typeof vi.fn>
  loadPrList: ReturnType<typeof vi.fn>
  renderFiles: ReturnType<typeof vi.fn>
  injectExistingComments: ReturnType<typeof vi.fn>
  updateViewedCounter: ReturnType<typeof vi.fn>
  showCommentStatus: ReturnType<typeof vi.fn>
  showCiPopover: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<Data> = {}): Harness {
  const dom = makeDom()
  const data: Data = {
    repoPath: '/repo',
    baseBranch: 'origin/main',
    selectedBranch: '',
    activeLocalBranch: '',
    allBranches: [],
    currentPrNumber: null,
    existingComments: [],
    loadingBranch: '',
    sidebarMode: 'branches',
    openPrs: [],
    fileTypeFilter: 'all',
    totalFiles: 0,
    lastFiles: [],
    lastStatusRollup: [],
    resolvedComments: new Set(),
    discSeq: 0,
    prInfoSeq: 0,
    currentPrTitle: '',
    currentPrBody: '',
    currentPrState: null,
    ...overrides,
  }
  const renderBranchList = vi.fn()
  const renderPrList = vi.fn()
  const loadPrList = vi.fn(async () => {})
  const renderFiles = vi.fn()
  const injectExistingComments = vi.fn()
  const updateViewedCounter = vi.fn()
  const showCommentStatus = vi.fn()
  const showCiPopover = vi.fn()
  const state: ReviewDataLoaderState = {
    getRepoPath: () => data.repoPath,
    setRepoPath: v => { data.repoPath = v },
    getBaseBranch: () => data.baseBranch,
    setBaseBranch: v => { data.baseBranch = v },
    getSelectedBranch: () => data.selectedBranch,
    setSelectedBranch: v => { data.selectedBranch = v },
    getActiveLocalBranch: () => data.activeLocalBranch,
    setActiveLocalBranch: v => { data.activeLocalBranch = v },
    getAllBranches: () => data.allBranches,
    setAllBranches: v => { data.allBranches = v },
    getCurrentPrNumber: () => data.currentPrNumber,
    setCurrentPrNumber: v => { data.currentPrNumber = v },
    getExistingComments: () => data.existingComments,
    setExistingComments: v => { data.existingComments = v },
    getLoadingBranch: () => data.loadingBranch,
    setLoadingBranch: v => { data.loadingBranch = v },
    getSidebarMode: () => data.sidebarMode,
    setOpenPrs: v => { data.openPrs = v },
    setFileTypeFilter: v => { data.fileTypeFilter = v },
    getTotalFiles: () => data.totalFiles,
    setTotalFiles: v => { data.totalFiles = v },
    getLastFiles: () => data.lastFiles,
    setLastFiles: v => { data.lastFiles = v },
    setLastStatusRollup: v => { data.lastStatusRollup = v },
    setResolvedComments: v => { data.resolvedComments = v },
    getResolvedComments: () => data.resolvedComments,
    nextDiscSeq: () => ++data.discSeq,
    getDiscSeq: () => data.discSeq,
    nextPrInfoSeq: () => ++data.prInfoSeq,
    getPrInfoSeq: () => data.prInfoSeq,
    setCurrentPrTitle: v => { data.currentPrTitle = v },
    setCurrentPrBody: v => { data.currentPrBody = v },
    getCurrentPrState: () => data.currentPrState,
    setCurrentPrState: v => { data.currentPrState = v },
    getViewedFiles: () => new Set<string>(),
    renderBranchList,
    renderPrList,
    loadPrList,
    renderFiles,
    injectExistingComments,
    updateViewedCounter,
    showCommentStatus,
    showCiPopover,
  }
  return { dom, data, state, renderBranchList, renderPrList, loadPrList, renderFiles, injectExistingComments, updateViewedCounter, showCommentStatus, showCiPopover }
}

const DIFF_A = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

function mockInvoke(map: Record<string, unknown>) {
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd in map) return map[cmd]
    throw new Error(`unmocked invoke: ${cmd}`)
  })
}

describe('loadDiff', () => {
  it('fetches via git_ref_diff for a non-active branch and renders the parsed files', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat', activeLocalBranch: 'main' })
    mockInvoke({ git_ref_diff: DIFF_A })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadDiff()
    expect(mocks.invoke).toHaveBeenCalledWith('git_ref_diff', { path: '/repo', base: 'origin/main', target: 'origin/feat' })
    expect(h.data.lastFiles).toHaveLength(1)
    expect(h.data.totalFiles).toBe(1)
    expect(h.renderFiles).toHaveBeenCalled()
    expect(h.updateViewedCounter).toHaveBeenCalled()
    expect(h.dom.diffSearchInput.classList.contains('hidden')).toBe(false)
  })

  it('uses the worktree diff when the selected branch is the active local branch', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'main', activeLocalBranch: 'main' })
    mockInvoke({ git_review_worktree_diff: DIFF_A })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadDiff()
    expect(mocks.invoke).toHaveBeenCalledWith('git_review_worktree_diff', { path: '/repo', base: 'origin/main' })
    expect(h.data.lastFiles).toHaveLength(1)
  })

  it('shows a no-changes message and resets file state when the diff is empty', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat', activeLocalBranch: 'main', lastFiles: [{ file: 'x' } as ReviewChangeFile], totalFiles: 1 })
    mockInvoke({ git_ref_diff: '' })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadDiff()
    expect(h.data.totalFiles).toBe(0)
    expect(h.data.lastFiles).toHaveLength(0)
    expect(h.dom.diffView.querySelector('.review-no-changes')).toBeTruthy()
  })

  it('falls back to the PR diff when a merged PR has no direct diff', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat', activeLocalBranch: 'main', currentPrState: 'MERGED', currentPrNumber: 7 })
    mockInvoke({ git_ref_diff: '', gh_pr_diff_number: DIFF_A })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadDiff()
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_diff_number', { path: '/repo', prNumber: 7 })
    expect(h.data.lastFiles).toHaveLength(1)
  })

  it('shows an error message when the diff fetch rejects', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat', activeLocalBranch: 'main' })
    mocks.invoke.mockImplementation(async () => { throw new Error('boom') })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadDiff()
    expect(h.dom.diffView.querySelector('.review-error')?.textContent).toContain('boom')
  })
})

describe('loadPrInfo', () => {
  const pr = {
    number: 42, title: 'Add thing', url: 'https://x/42', body: 'desc', state: 'OPEN', mergedAt: null,
    statusCheckRollup: [{ conclusion: 'SUCCESS' }] as StatusRollupEntry[],
    reviewDecision: 'APPROVED',
  }

  it('populates PR metadata, comments and CI status on success', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat' })
    mockInvoke({
      gh_pr_view_branch: pr,
      gh_pr_list_comments: [{ id: 1, path: 'a.ts', line: 3, body: 'x', user: { login: 'u' }, html_url: '' }],
      gh_pr_list_discussion: { comments: [], reviews: [] },
      // Cómo van los checks lo cuenta `bento_review::pr`.
      gh_pr_check_report: { verdicts: ['passed'], failed: 0, pending: 0, total: 1 },
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadPrInfo()
    expect(h.data.currentPrNumber).toBe(42)
    expect(h.data.currentPrTitle).toBe('Add thing')
    expect(h.dom.prMetaEl.querySelector('.review-pr-link')?.textContent).toContain('#42')
    expect(h.dom.prMetaEl.querySelector('.review-ci--success')).toBeTruthy()
    expect(h.dom.prMetaEl.querySelector('.review-decision--approved')).toBeTruthy()
    expect(h.data.existingComments).toHaveLength(1)
    expect(h.dom.commentBar.classList.contains('hidden')).toBe(false)
  })

  it('ignores a stale response when a newer loadPrInfo call has already started', async () => {
    setup()
    const h = makeHarness({ selectedBranch: 'origin/feat' })
    let resolveFirst!: (v: typeof pr) => void
    const firstPr = new Promise<typeof pr>(resolve => { resolveFirst = resolve })
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'gh_pr_view_branch') return h.data.prInfoSeq === 1 ? firstPr : { ...pr, number: 99 }
      if (cmd === 'gh_pr_list_comments') return []
      if (cmd === 'gh_pr_list_discussion') return { comments: [], reviews: [] }
      throw new Error(`unmocked: ${cmd}`)
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    const first = loader.loadPrInfo()
    await loader.loadPrInfo()
    expect(h.data.currentPrNumber).toBe(99)
    resolveFirst(pr)
    await first
    // The stale first response must not clobber the second, newer result.
    expect(h.data.currentPrNumber).toBe(99)
  })
})

describe('selectBranch', () => {
  it('sets the branch, loads diff and PR info, then injects comments', async () => {
    setup()
    const h = makeHarness()
    mockInvoke({
      git_ref_diff: '',
      gh_pr_view_branch: null,
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.selectBranch('origin/feat')
    expect(h.data.selectedBranch).toBe('origin/feat')
    expect(h.renderBranchList).toHaveBeenCalled()
    expect(h.injectExistingComments).toHaveBeenCalled()
  })

  it('does not inject comments for a branch superseded by a newer selection', async () => {
    setup()
    const h = makeHarness()
    let resolveFirstDiff!: (v: string) => void
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_ref_diff') {
        return new Promise<string>(resolve => { resolveFirstDiff = resolve })
      }
      if (cmd === 'gh_pr_view_branch') return null
      throw new Error(`unmocked: ${cmd}`)
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    const firstSelect = loader.selectBranch('origin/a')
    // Supersede before the first diff resolves.
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'git_ref_diff') return ''
      if (cmd === 'gh_pr_view_branch') return null
      throw new Error(`unmocked: ${cmd}`)
    })
    await loader.selectBranch('origin/b')
    expect(h.injectExistingComments).toHaveBeenCalledTimes(1)
    resolveFirstDiff('')
    await firstSelect
    // The stale first selectBranch call must not fire a second injection.
    expect(h.injectExistingComments).toHaveBeenCalledTimes(1)
  })
})

describe('submitReview', () => {
  it('does nothing without an active PR', async () => {
    setup()
    const h = makeHarness({ currentPrNumber: null })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.submitReview('APPROVE')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('does nothing when the confirmation is cancelled', async () => {
    setup()
    vi.stubGlobal('confirm', () => false)
    const h = makeHarness({ currentPrNumber: 5 })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.submitReview('APPROVE')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('submits the review and refreshes PR info on confirm', async () => {
    setup()
    vi.stubGlobal('confirm', () => true)
    const h = makeHarness({ currentPrNumber: 5, selectedBranch: 'origin/feat' })
    mockInvoke({ gh_pr_submit_review: 'ok', gh_pr_view_branch: null })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.submitReview('APPROVE')
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_submit_review', { path: '/repo', prNumber: 5, event: 'APPROVE', body: '' })
    expect(h.showCommentStatus).toHaveBeenCalledWith('Review submitted')
    expect(h.injectExistingComments).toHaveBeenCalled()
  })
})

describe('loadBranches', () => {
  it('puts the current branch first and defaults the base branch to origin/<default>', async () => {
    setup()
    const h = makeHarness({ baseBranch: '' })
    mockInvoke({
      git_default_branch: 'main',
      git_review_branches: ['origin/main', 'origin/feat/login'],
      git_current_branch: 'feat/login',
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadBranches()
    expect(h.data.allBranches[0]).toBe('feat/login')
    expect(h.data.baseBranch).toBe('origin/main')
    expect(h.renderBranchList).toHaveBeenCalled()
    expect(h.loadPrList).toHaveBeenCalled()
  })

  it('auto-selects the current branch when it differs from the default', async () => {
    setup()
    const h = makeHarness({ baseBranch: 'origin/main' })
    mockInvoke({
      git_default_branch: 'main',
      git_review_branches: ['origin/main', 'origin/feat/login'],
      git_current_branch: 'feat/login',
      git_ref_diff: '',
      gh_pr_view_branch: null,
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadBranches()
    expect(h.data.selectedBranch).toBe('feat/login')
  })
})

describe('pickRepo', () => {
  it('does nothing when the folder picker is cancelled', async () => {
    setup()
    mocks.pickFolder.mockResolvedValue(null)
    const h = makeHarness({ repoPath: '/old' })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.pickRepo()
    expect(h.data.repoPath).toBe('/old')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('resets state and loads branches for the picked repo', async () => {
    setup()
    mocks.pickFolder.mockResolvedValue('/new/repo')
    const h = makeHarness({ repoPath: '/old', existingComments: [{ id: 1 } as GhComment], totalFiles: 3 })
    mockInvoke({ git_default_branch: 'main', git_review_branches: [], git_current_branch: '' })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.pickRepo()
    expect(h.data.repoPath).toBe('/new/repo')
    expect(h.data.existingComments).toHaveLength(0)
    expect(h.data.totalFiles).toBe(0)
    expect(mocks.invoke).toHaveBeenCalledWith('git_default_branch', { repo: '/new/repo' })
  })
})

describe('prIdentifier', () => {
  it('returns the PR number when one is set', () => {
    setup()
    const h = makeHarness({ currentPrNumber: 11, selectedBranch: 'origin/feat' })
    const loader = buildReviewDataLoader(h.dom, h.state)
    expect(loader.prIdentifier()).toBe('11')
  })

  it('falls back to the bare branch name (remote prefix stripped) when there is no PR', () => {
    setup()
    const h = makeHarness({ currentPrNumber: null, selectedBranch: 'origin/feat/login' })
    const loader = buildReviewDataLoader(h.dom, h.state)
    expect(loader.prIdentifier()).toBe('feat/login')
  })
})

describe('loadExistingComments', () => {
  it('filters out comments without a line number', async () => {
    setup()
    const h = makeHarness({ currentPrNumber: 3 })
    mockInvoke({
      gh_pr_list_comments: [
        { id: 1, path: 'a.ts', line: 2, body: 'x', user: { login: 'u' }, html_url: '' },
        { id: 2, path: 'a.ts', line: null, body: 'y', user: { login: 'u' }, html_url: '' },
      ],
    })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadExistingComments()
    expect(h.data.existingComments).toHaveLength(1)
    expect(h.data.existingComments[0].id).toBe(1)
  })

  it('clears comments when there is no active PR', async () => {
    setup()
    const h = makeHarness({ currentPrNumber: null, existingComments: [{ id: 1 } as GhComment] })
    const loader = buildReviewDataLoader(h.dom, h.state)
    await loader.loadExistingComments()
    expect(h.data.existingComments).toHaveLength(0)
  })
})
