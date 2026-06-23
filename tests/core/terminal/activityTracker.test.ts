import { describe, it, expect, vi } from 'vitest'
import { createActivityTracker } from '../../../src/core/terminal/activityTracker'

describe('createActivityTracker', () => {
  it('does not push before setBase is called', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.onOutput(false)
    t.onFocus()
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('setBase pushes the clean title', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    expect(onTitle).toHaveBeenCalledOnce()
    expect(onTitle).toHaveBeenCalledWith('Terminal 1')
  })

  it('onOutput without focus pushes dot title', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    onTitle.mockClear()
    t.onOutput(false)
    expect(onTitle).toHaveBeenCalledOnce()
    expect(onTitle).toHaveBeenCalledWith('Terminal 1 ●')
  })

  it('onOutput with focus does not push', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    onTitle.mockClear()
    t.onOutput(true)
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('onOutput twice only pushes once', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    onTitle.mockClear()
    t.onOutput(false)
    t.onOutput(false)
    expect(onTitle).toHaveBeenCalledOnce()
  })

  it('onFocus clears activity and pushes clean title', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    t.onOutput(false)
    onTitle.mockClear()
    t.onFocus()
    expect(onTitle).toHaveBeenCalledOnce()
    expect(onTitle).toHaveBeenCalledWith('Terminal 1')
  })

  it('onFocus when inactive does not push', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    onTitle.mockClear()
    t.onFocus()
    expect(onTitle).not.toHaveBeenCalled()
  })

  it('setBase resets activity state', () => {
    const onTitle = vi.fn()
    const t = createActivityTracker(onTitle)
    t.setBase('Terminal 1')
    t.onOutput(false)
    t.setBase('New Title')
    onTitle.mockClear()
    t.onOutput(false)
    expect(onTitle).toHaveBeenCalledWith('New Title ●')
  })
})
