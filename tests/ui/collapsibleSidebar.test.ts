// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'

import { collapsedKey, createCollapsibleSidebar, widthKey } from '../../src/ui/collapsibleSidebar'

describe('collapsibleSidebar storage keys', () => {
  it('derives collapsed key from storageKey', () => {
    expect(collapsedKey('bento.tasks.sidebar')).toBe('bento.tasks.sidebar.collapsed')
  })
  it('derives width key from storageKey', () => {
    expect(widthKey('bento.tasks.sidebar')).toBe('bento.tasks.sidebar.width')
  })
})

describe('collapsibleSidebar width', () => {
  beforeEach(() => localStorage.clear())

  // A width saved on a wider window/monitor must not swallow the detail pane:
  // the sidebar is capped by CSS so the cap follows the container live.
  it('caps the sidebar so the detail pane keeps minRemaining px', () => {
    localStorage.setItem(widthKey('bento.review.sidebar'), '2803')
    const cs = createCollapsibleSidebar({
      storageKey: 'bento.review.sidebar',
      title: 'Review',
      minRemaining: 420,
      container: document.createElement('div'),
    })
    expect(cs.element.style.width).toBe('2803px')
    expect(cs.element.style.maxWidth).toBe('calc(100% - 420px)')
  })
})
