// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { createDiffPanel, diffRepoStorageKey, diffRepoPathsFromKeys } from '../../../src/panels/diff/DiffPanel'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
}

describe('DiffPanel', () => {
  it('uses a separate storage key for each project session', () => {
    expect(diffRepoStorageKey('/projects/one')).not.toBe(diffRepoStorageKey('/projects/two'))
    expect(diffRepoStorageKey('/projects/one')).toContain(encodeURIComponent('/projects/one'))
  })

  it('uses a separate storage key for each diff panel in one project', () => {
    expect(diffRepoStorageKey('/projects/one', 'diff-1')).not.toBe(diffRepoStorageKey('/projects/one', 'diff-2'))
  })

  it('starts a new project-scoped diff panel without a repository', () => {
    setup()
    localStorage.setItem(diffRepoStorageKey('/projects/one', 'diff-2'), '/projects/one')
    const { element } = createDiffPanel('/projects/one', 'diff-2')
    expect(element.querySelector('.diff-empty-state')?.classList.contains('hidden')).toBe(false)
  })

  it('recovers distinct recent project paths from storage keys', () => {
    const keys = [diffRepoStorageKey('/projects/one'), diffRepoStorageKey('/projects/two'), 'other.key']
    expect(diffRepoPathsFromKeys(keys)).toEqual(['/projects/one', '/projects/two'])
  })

  it('returns an element with diff-panel class', () => {
    setup()
    const { element } = createDiffPanel()
    expect(element.classList.contains('diff-panel')).toBe(true)
  })

  it('shows empty state when no project path and no saved repo', () => {
    setup()
    const { element } = createDiffPanel()
    const emptyState = element.querySelector('.diff-empty-state')
    expect(emptyState?.classList.contains('hidden')).toBe(false)
  })

  it('renders worktree/log toggle buttons', () => {
    setup()
    const { element } = createDiffPanel()
    const buttons = element.querySelectorAll('.diff-mode-btn')
    expect(buttons.length).toBe(2)
  })

  it('worktree button is active by default', () => {
    setup()
    const { element } = createDiffPanel()
    const [worktreeBtn] = element.querySelectorAll<HTMLButtonElement>('.diff-mode-btn')
    expect(worktreeBtn?.classList.contains('diff-mode-btn--active')).toBe(true)
  })

  it('shows open-repo button in empty state', () => {
    setup()
    const { element } = createDiffPanel()
    const openBtn = element.querySelector('.diff-empty-open-btn')
    expect(openBtn).not.toBeNull()
    expect(openBtn?.textContent).toContain('Open repo')
  })

  it('starts empty even when a legacy repo exists in localStorage', () => {
    setup()
    localStorage.setItem('bento.diff.repo', '/some/project')
    vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }))
    const { element } = createDiffPanel()
    expect(element.querySelector('.diff-empty-state')?.classList.contains('hidden')).toBe(false)
  })

  it('uses the saved repo when the session path is empty', () => {
    setup()
    localStorage.setItem('bento.diff.repo', '/some/project')
    vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }))
    const { element } = createDiffPanel('')
    expect(element.querySelector('.diff-empty-state')?.classList.contains('hidden')).toBe(true)
  })
})
