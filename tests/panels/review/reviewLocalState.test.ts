// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildReviewLocalState } from '../../../src/panels/review/reviewLocalState'

// The shared store, as the Rust commands see it: one list per repo and ref.
function fakeStore(initial: Record<string, string[]> = {}) {
  const files = { ...initial }
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const { cwd, base, paths } = (args ?? {}) as { cwd: string, base: string, paths?: string[] }
    if (cmd === 'review_viewed_get') return files[`${cwd}:${base}`] ?? []
    if (cmd === 'review_viewed_set') { files[`${cwd}:${base}`] = paths ?? []; return null }
    return null
  })
  return files
}

function setup(overrides: { repoPath?: string, branch?: string, pr?: number | null, total?: number } = {}) {
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
    fakeStore()
  })

  it('remembers a file marked as viewed', async () => {
    const { state } = setup()
    state.setFileViewed('src/a.ts', true)

    const other = setup()
    await other.state.loadViewedFiles()
    expect([...other.state.getViewedFiles()]).toEqual(['src/a.ts'])
  })

  it('forgets it when unmarked', async () => {
    const { state } = setup()
    state.setFileViewed('src/a.ts', true)
    state.setFileViewed('src/a.ts', false)

    const other = setup()
    await other.state.loadViewedFiles()
    expect(other.state.getViewedFiles().size).toBe(0)
  })

  it('keeps each branch of a repo apart', async () => {
    setup({ branch: 'feat/a' }).state.setFileViewed('src/a.ts', true)

    const other = setup({ branch: 'feat/b' })
    await other.state.loadViewedFiles()
    expect(other.state.getViewedFiles().size).toBe(0)
  })

  it('marks travel to the store the CLI and the phone read', async () => {
    const { state } = setup()

    state.setFileViewed('src/a.ts', true)

    // Marking a file read on the desktop and carrying on from the phone is
    // the whole point of one store: this used to stay in the browser.
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'review_viewed_set', { cwd: '/repo', base: 'feat/a', paths: ['src/a.ts'] },
    ))
  })

  it('sees what another client marked', async () => {
    fakeStore({ '/repo:feat/a': ['src/desde-el-movil.ts'] })
    const { state } = setup()

    await state.loadViewedFiles()

    expect([...state.getViewedFiles()]).toEqual(['src/desde-el-movil.ts'])
  })

  it('carries over what the browser had, once', async () => {
    // Marks made before the store existed are not worth losing; moving them
    // clears the browser copy, so unmarking a file cannot resurrect it.
    localStorage.setItem('bento.review.viewed./repo.feat/a', JSON.stringify(['src/viejo.ts']))
    const files = fakeStore()
    const { state } = setup()

    await state.loadViewedFiles()

    expect([...state.getViewedFiles()]).toEqual(['src/viejo.ts'])
    expect(files['/repo:feat/a']).toEqual(['src/viejo.ts'])
    expect(localStorage.getItem('bento.review.viewed./repo.feat/a')).toBeNull()
  })

  it('a store that cannot be read is nothing marked, not a broken panel', async () => {
    mocks.invoke.mockImplementation(async () => { throw new Error('sin store') })
    const { state } = setup()

    await state.loadViewedFiles()

    expect(state.getViewedFiles().size).toBe(0)
  })

  it('counts what is viewed out of the total', async () => {
    const { state, viewedCounterEl } = setup({ total: 3 })
    state.setFileViewed('src/a.ts', true)
    expect(viewedCounterEl.textContent).toContain('1')
    expect(viewedCounterEl.classList.contains('hidden')).toBe(false)
  })

  it('hides the counter when there are no files', () => {
    const { state, viewedCounterEl } = setup({ total: 0 })
    state.updateViewedCounter()
    expect(viewedCounterEl.classList.contains('hidden')).toBe(true)
  })



})
