// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { createDiffPanel } from '../../../src/panels/diff/DiffPanel'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
}

describe('DiffPanel', () => {
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

  it('hides empty state when saved repo exists in localStorage', () => {
    setup()
    localStorage.setItem('bento.diff.repo', '/some/project')
    vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('') }))
    const { element } = createDiffPanel()
    const emptyState = element.querySelector('.diff-empty-state')
    expect(emptyState?.classList.contains('hidden')).toBe(true)
  })
})
