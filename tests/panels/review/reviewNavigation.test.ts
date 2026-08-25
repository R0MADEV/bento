// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildReviewNavigation } from '../../../src/panels/review/reviewNavigation'

function setup(files: string[], comments = 0) {
  const diffView = document.createElement('div')
  files.forEach(name => {
    const el = document.createElement('details')
    el.className = 'review-file-detail'
    el.dataset.filename = name
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'review-viewed-cb'
    el.append(cb)
    el.scrollIntoView = vi.fn()
    diffView.append(el)
  })
  for (let i = 0; i < comments; i++) {
    const c = document.createElement('div')
    c.className = 'review-existing-comment'
    c.scrollIntoView = vi.fn()
    diffView.append(c)
  }
  const commentNavWrap = document.createElement('div')
  const viewed = new Set<string>()
  const nav = buildReviewNavigation({ diffView, commentNavWrap, getViewedFiles: () => viewed })
  return { nav, diffView, commentNavWrap, viewed }
}

const focused = (diffView: HTMLElement): string | undefined =>
  diffView.querySelector<HTMLElement>('.review-file-focused')?.dataset.filename

describe('review navigation', () => {
  it('hides the comment arrows when the diff has no comments', () => {
    const { nav, commentNavWrap } = setup(['a.ts'])
    nav.updateCommentNav()
    expect(commentNavWrap.classList.contains('hidden')).toBe(true)
  })

  it('shows them as soon as there is one', () => {
    const { nav, commentNavWrap } = setup(['a.ts'], 1)
    nav.updateCommentNav()
    expect(commentNavWrap.classList.contains('hidden')).toBe(false)
  })

  it('moves the focus one file at a time', () => {
    const { nav, diffView } = setup(['a.ts', 'b.ts'])
    nav.navigateFile(1)
    expect(focused(diffView)).toBe('a.ts')
    nav.navigateFile(1)
    expect(focused(diffView)).toBe('b.ts')
  })

  it('wraps around at the end instead of stopping', () => {
    const { nav, diffView } = setup(['a.ts', 'b.ts'])
    nav.navigateFile(1)
    nav.navigateFile(1)
    nav.navigateFile(1)
    expect(focused(diffView)).toBe('a.ts')
  })

  it('focuses exactly one file at a time', () => {
    const { nav, diffView } = setup(['a.ts', 'b.ts'])
    nav.navigateFile(1)
    nav.navigateFile(1)
    expect(diffView.querySelectorAll('.review-file-focused')).toHaveLength(1)
  })

  it('jumps to the first file not reviewed yet', () => {
    const { nav, diffView, viewed } = setup(['a.ts', 'b.ts', 'c.ts'])
    viewed.add('a.ts')
    viewed.add('b.ts')
    nav.navigateUnviewed()
    expect(focused(diffView)).toBe('c.ts')
  })

  it('does nothing when every file is reviewed', () => {
    const { nav, diffView, viewed } = setup(['a.ts'])
    viewed.add('a.ts')
    nav.navigateUnviewed()
    expect(focused(diffView)).toBeUndefined()
  })

  it('toggles the checkbox of the focused file', () => {
    const { nav, diffView } = setup(['a.ts'])
    nav.navigateFile(1)
    nav.toggleCurrentViewed()
    expect(diffView.querySelector<HTMLInputElement>('.review-viewed-cb')!.checked).toBe(true)
  })

  it('ignores the shortcuts when the panel is no longer on screen', () => {
    const { nav, diffView } = setup(['a.ts', 'b.ts'])
    nav.handleKeydown(new KeyboardEvent('keydown', { key: 'j' }), false)
    expect(focused(diffView)).toBeUndefined()
  })

  it('ignores them while typing in a field', () => {
    const { nav, diffView } = setup(['a.ts'])
    const input = document.createElement('input')
    document.body.append(input)
    const event = new KeyboardEvent('keydown', { key: 'j' })
    Object.defineProperty(event, 'target', { value: input })
    nav.handleKeydown(event, true)
    expect(focused(diffView)).toBeUndefined()
  })

  it('resets the focus when the file list is redrawn', () => {
    const { nav, diffView } = setup(['a.ts', 'b.ts'])
    nav.navigateFile(1)
    nav.resetFocusedFile()
    nav.navigateFile(1)
    expect(focused(diffView)).toBe('a.ts')
  })
})
