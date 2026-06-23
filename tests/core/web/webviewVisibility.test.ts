import { describe, it, expect } from 'vitest'
import { isWebviewVisible } from '../../../src/core/web/webviewVisibility'

const visible = { intersecting: true, visibility: 'visible', display: 'block', opacity: '1', suppressed: false }

describe('isWebviewVisible', () => {
  it('is visible when intersecting, shown, displayed and opaque', () => {
    expect(isWebviewVisible(visible)).toBe(true)
  })

  it('is hidden when suppressed by an overlay (popover/menu above the panel)', () => {
    expect(isWebviewVisible({ ...visible, suppressed: true })).toBe(false)
  })

  it('is hidden when not intersecting (out of viewport / display:none ancestor)', () => {
    expect(isWebviewVisible({ ...visible, intersecting: false })).toBe(false)
  })

  it('is hidden when visibility is hidden (inherited from a hidden session)', () => {
    expect(isWebviewVisible({ ...visible, visibility: 'hidden' })).toBe(false)
  })

  it('is hidden when display is none', () => {
    expect(isWebviewVisible({ ...visible, display: 'none' })).toBe(false)
  })

  it('is hidden when opacity is 0', () => {
    expect(isWebviewVisible({ ...visible, opacity: '0' })).toBe(false)
  })

  it('is visible at partial opacity', () => {
    expect(isWebviewVisible({ ...visible, opacity: '0.4' })).toBe(true)
  })
})
