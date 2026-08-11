import { describe, it, expect } from 'vitest'

// The collapsible sidebar is DOM-heavy (HTMLElement, classList, events) and
// vitest runs without jsdom in this project, so we test only the pure key
// derivation logic that drives persistence — the toggle/DOM behaviour is
// covered by the agents panel which already uses the same mechanism.

import { collapsedKey, widthKey } from '../../src/ui/collapsibleSidebar'

describe('collapsibleSidebar storage keys', () => {
  it('derives collapsed key from storageKey', () => {
    expect(collapsedKey('bento.tasks.sidebar')).toBe('bento.tasks.sidebar.collapsed')
  })
  it('derives width key from storageKey', () => {
    expect(widthKey('bento.tasks.sidebar')).toBe('bento.tasks.sidebar.width')
  })
})
