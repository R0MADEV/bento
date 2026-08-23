// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildReviewDiffView, type ReviewDiffState } from '../../../src/panels/review/ReviewDiffView'
import type { ReviewChangeFile, GhComment } from '../../../src/panels/review/reviewFormat'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue('')
}

function makeDom() {
  return {
    diffView: document.createElement('div'),
    diffSearchInput: Object.assign(document.createElement('input'), { type: 'search' }) as HTMLInputElement,
    filterBar: document.createElement('div'),
  }
}

const UNIFIED_CHUNK = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old line',
  '+new line',
  ' context line',
].join('\n')

function makeFile(over: Partial<ReviewChangeFile> = {}): ReviewChangeFile {
  return { file: 'src/a.ts', additions: 1, deletions: 1, chunk: UNIFIED_CHUNK, state: 'M', ...over } as ReviewChangeFile
}

interface Harness {
  dom: ReturnType<typeof makeDom>
  state: ReviewDiffState
  data: {
    lastFiles: ReviewChangeFile[]
    treeView: boolean
    splitView: boolean
    existingComments: GhComment[]
    fileTypeFilter: import('../../../src/panels/review/reviewFormat').FileTypeFilter
    viewedFiles: Set<string>
    repoPath: string
    currentPrNumber: number | null
  }
  setFileViewed: ReturnType<typeof vi.fn>
  buildCommentBubble: ReturnType<typeof vi.fn>
  makeLineForm: ReturnType<typeof vi.fn>
  updateCommentNav: ReturnType<typeof vi.fn>
  showSentLink: ReturnType<typeof vi.fn>
}

function makeHarness(overrides: Partial<Harness['data']> = {}): Harness {
  const dom = makeDom()
  const data: Harness['data'] = {
    lastFiles: [makeFile()],
    treeView: false,
    splitView: false,
    existingComments: [],
    fileTypeFilter: 'all',
    viewedFiles: new Set(),
    repoPath: '/repo',
    currentPrNumber: 42,
    ...overrides,
  }
  const setFileViewed = vi.fn((file: string, viewed: boolean) => {
    if (viewed) data.viewedFiles.add(file); else data.viewedFiles.delete(file)
  })
  const buildCommentBubble = vi.fn((c: GhComment) => {
    const el = document.createElement('div')
    el.className = 'review-existing-comment'
    el.dataset.commentId = String(c.id)
    return el
  })
  const makeLineForm = vi.fn(() => document.createElement('div'))
  const updateCommentNav = vi.fn()
  const showSentLink = vi.fn()
  const state: ReviewDiffState = {
    getLastFiles: () => data.lastFiles,
    getTreeView: () => data.treeView,
    getSplitView: () => data.splitView,
    getExistingComments: () => data.existingComments,
    getFileTypeFilter: () => data.fileTypeFilter,
    setFileTypeFilter: value => { data.fileTypeFilter = value },
    resetFocusedFileIdx: vi.fn(),
    getViewedFiles: () => data.viewedFiles,
    setFileViewed,
    repoPath: () => data.repoPath,
    getCurrentPrNumber: () => data.currentPrNumber,
    getPrIdentifier: () => (data.currentPrNumber !== null ? String(data.currentPrNumber) : 'branch'),
    buildCommentBubble,
    makeLineForm,
    updateCommentNav,
    showSentLink,
  }
  return { dom, state, data, setFileViewed, buildCommentBubble, makeLineForm, updateCommentNav, showSentLink }
}

describe('renderFiles', () => {
  it('renders one file-detail per file with correct state/filename dataset', () => {
    setup()
    const h = makeHarness({ lastFiles: [makeFile({ file: 'src/a.ts', state: 'M' }), makeFile({ file: 'src/b.ts', state: 'A' })] })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const details = h.dom.diffView.querySelectorAll<HTMLElement>('.review-file-detail')
    expect(details).toHaveLength(2)
    expect(details[0].dataset.filename).toBe('src/a.ts')
    expect(details[0].dataset.filestate).toBe('M')
    expect(details[1].dataset.filestate).toBe('A')
  })

  it('groups files by directory in tree view with a dir-name header', () => {
    setup()
    const h = makeHarness({
      treeView: true,
      lastFiles: [makeFile({ file: 'src/nested/a.ts' }), makeFile({ file: 'root.ts' })],
    })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const dirHeaders = [...h.dom.diffView.querySelectorAll('.review-tree-dir-name')].map(el => el.textContent)
    expect(dirHeaders).toEqual(['src/nested/'])
    expect(h.dom.diffView.querySelectorAll('.review-file-detail')).toHaveLength(2)
  })

  it('renders unified diff lines with correct add/del markup and line numbers', () => {
    setup()
    const h = makeHarness()
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const detail = h.dom.diffView.querySelector('.review-file-detail')!
    const addWrap = detail.querySelector('.tasks-diff-line-add')!.closest('[data-line]') as HTMLElement
    expect(addWrap.dataset.line).toBe('1')
    expect(detail.querySelector('.tasks-diff-line-del')).toBeTruthy()
  })

  it('renders split view as left/right rows when splitView is enabled', () => {
    setup()
    const h = makeHarness({ splitView: true })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const detail = h.dom.diffView.querySelector('.review-file-detail')!
    expect(detail.querySelector('.review-split-diff')).toBeTruthy()
    expect(detail.querySelectorAll('.review-split-row').length).toBeGreaterThan(0)
  })

  it('resets focused file index on every render', () => {
    setup()
    const h = makeHarness()
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    expect(h.state.resetFocusedFileIdx).toHaveBeenCalled()
  })
})

describe('applyVisibility', () => {
  it('hides files that do not match the active type filter', () => {
    setup()
    const h = makeHarness({
      lastFiles: [makeFile({ file: 'src/a.ts', state: 'M' }), makeFile({ file: 'src/b.ts', state: 'A' })],
      fileTypeFilter: 'A',
    })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const [a, b] = [...h.dom.diffView.querySelectorAll<HTMLElement>('.review-file-detail')]
    expect(a.classList.contains('hidden')).toBe(true)
    expect(b.classList.contains('hidden')).toBe(false)
  })

  it('hides files without comments when the commented filter is active', () => {
    setup()
    const h = makeHarness({
      lastFiles: [makeFile({ file: 'src/a.ts' }), makeFile({ file: 'src/b.ts' })],
      existingComments: [{ id: 1, path: 'src/b.ts', line: 1, body: 'x', user: { login: 'u' }, html_url: '' }],
      fileTypeFilter: 'commented',
    })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const [a, b] = [...h.dom.diffView.querySelectorAll<HTMLElement>('.review-file-detail')]
    expect(a.classList.contains('hidden')).toBe(true)
    expect(b.classList.contains('hidden')).toBe(false)
  })

  it('hides files that do not match the search text', () => {
    setup()
    const h = makeHarness({ lastFiles: [makeFile({ file: 'src/a.ts' }), makeFile({ file: 'src/b.ts' })] })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    h.dom.diffSearchInput.value = 'b.ts'
    view.applyVisibility()
    const [a, b] = [...h.dom.diffView.querySelectorAll<HTMLElement>('.review-file-detail')]
    expect(a.classList.contains('hidden')).toBe(true)
    expect(b.classList.contains('hidden')).toBe(false)
  })

  it('re-applies visibility automatically when the search input fires', () => {
    setup()
    const h = makeHarness({ lastFiles: [makeFile({ file: 'src/a.ts' }), makeFile({ file: 'src/b.ts' })] })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    h.dom.diffSearchInput.value = 'a.ts'
    h.dom.diffSearchInput.dispatchEvent(new Event('input'))
    const [a, b] = [...h.dom.diffView.querySelectorAll<HTMLElement>('.review-file-detail')]
    expect(a.classList.contains('hidden')).toBe(false)
    expect(b.classList.contains('hidden')).toBe(true)
  })
})

describe('viewed checkbox', () => {
  it('calls setFileViewed and marks the file viewed', () => {
    setup()
    const h = makeHarness()
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    const cb = h.dom.diffView.querySelector<HTMLInputElement>('.review-viewed-cb')!
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(h.setFileViewed).toHaveBeenCalledWith('src/a.ts', true)
    expect(h.dom.diffView.querySelector('.review-file-detail')?.classList.contains('review-file-viewed')).toBe(true)
  })
})

describe('editor button', () => {
  it('opens the file in the editor with the full repo path', () => {
    setup()
    const h = makeHarness({ repoPath: '/my/repo' })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    h.dom.diffView.querySelector<HTMLElement>('.review-editor-btn')!.click()
    expect(mocks.invoke).toHaveBeenCalledWith('open_in_editor', { path: '/my/repo/src/a.ts' })
  })
})

describe('file comment button', () => {
  it('sends a file-level comment through gh_pr_comment and shows the sent link', async () => {
    setup()
    mocks.invoke.mockResolvedValueOnce('https://github.com/x/y/pull/42#comment')
    const h = makeHarness({ currentPrNumber: 42 })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    h.dom.diffView.querySelector<HTMLElement>('.review-file-comment-btn')!.click()
    const textarea = h.dom.diffView.querySelector<HTMLTextAreaElement>('.review-file-comment-form textarea')!
    textarea.value = 'looks good'
    const sendBtn = h.dom.diffView.querySelector<HTMLButtonElement>('.review-file-comment-form .review-comment-btn')!
    sendBtn.click()
    await vi.waitFor(() => expect(h.showSentLink).toHaveBeenCalled())
    expect(mocks.invoke).toHaveBeenCalledWith('gh_pr_comment', { path: '/repo', branch: '42', body: '**src/a.ts**\n\nlooks good' })
  })

  it('does not send when there is no active PR', () => {
    setup()
    const h = makeHarness({ currentPrNumber: null })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    h.dom.diffView.querySelector<HTMLElement>('.review-file-comment-btn')!.click()
    const textarea = h.dom.diffView.querySelector<HTMLTextAreaElement>('.review-file-comment-form textarea')!
    textarea.value = 'no pr yet'
    h.dom.diffView.querySelector<HTMLButtonElement>('.review-file-comment-form .review-comment-btn')!.click()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('injectExistingComments', () => {
  it('injects a bubble inline next to the matching line and calls updateCommentNav', () => {
    setup()
    const h = makeHarness({
      existingComments: [{ id: 7, path: 'src/a.ts', line: 1, body: 'hi', user: { login: 'u' }, html_url: '' }],
    })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    view.injectExistingComments()
    expect(h.buildCommentBubble).toHaveBeenCalledTimes(1)
    expect(h.dom.diffView.querySelector('.review-existing-comment')).toBeTruthy()
    expect(h.dom.diffView.querySelector('.review-comment-orphans')).toBeFalsy()
    expect(h.updateCommentNav).toHaveBeenCalled()
  })

  it('puts comments whose line is not in the diff into an orphan section', () => {
    setup()
    const h = makeHarness({
      existingComments: [{ id: 9, path: 'src/a.ts', line: 999, body: 'gone', user: { login: 'u' }, html_url: '' }],
    })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    view.injectExistingComments()
    expect(h.dom.diffView.querySelector('.review-comment-orphans')).toBeTruthy()
  })
})

describe('updateCommentBadges', () => {
  it('shows a badge with the comment count for a file and hides it when empty', () => {
    setup()
    const h = makeHarness({
      existingComments: [{ id: 1, path: 'src/a.ts', line: 1, body: 'x', user: { login: 'u' }, html_url: '' }],
    })
    const view = buildReviewDiffView(h.dom, h.state)
    view.renderFiles()
    view.updateCommentBadges()
    const badge = h.dom.diffView.querySelector<HTMLElement>('.review-comment-badge')!
    expect(badge.classList.contains('hidden')).toBe(false)
    expect(badge.textContent).toContain('1')

    h.data.existingComments = []
    view.updateCommentBadges()
    expect(badge.classList.contains('hidden')).toBe(true)
  })
})
