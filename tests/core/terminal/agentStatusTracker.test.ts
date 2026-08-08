import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAgentStatusTracker, BLOCKED_TIMEOUT_MS, IDLE_AFTER_BLOCKED_MS } from '../../../src/core/terminal/agentStatusTracker'

describe('createAgentStatusTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not notify on creation — initial state is idle', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    expect(cb).not.toHaveBeenCalled()
  })

  it('transitions to working on command start', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith('working')
  })

  it('output while idle transitions to working — no OSC 133 needed', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onOutput()
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith('working')
  })

  it('transitions to blocked after the idle timeout', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    cb.mockClear()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS)
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith('blocked')
  })

  it('transitions to idle after blocked timeout elapses', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS + IDLE_AFTER_BLOCKED_MS)
    expect(cb).toHaveBeenCalledWith('idle')
  })

  it('output while blocked resets state to working', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS)
    cb.mockClear()
    t.onOutput()
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith('working')
  })

  it('output resets the blocked timer', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS - 1000)
    t.onOutput()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS - 1000)
    expect(cb).not.toHaveBeenCalledWith('blocked')
    vi.advanceTimersByTime(1001)
    expect(cb).toHaveBeenCalledWith('blocked')
  })

  it('transitions to idle on command end', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    cb.mockClear()
    t.onCommandEnd()
    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith('idle')
  })

  it('command end cancels the blocked and idle timers', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    t.onCommandEnd()
    cb.mockClear()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS + IDLE_AFTER_BLOCKED_MS)
    expect(cb).not.toHaveBeenCalled()
  })

  it('duplicate transitions do not fire extra notifications', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    t.onCommandStart()
    expect(cb).toHaveBeenCalledOnce()
  })

  it('onChange unsubscribe stops future notifications', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    const unsub = t.onChange(cb)
    t.onCommandStart()
    unsub()
    t.onCommandEnd()
    expect(cb).toHaveBeenCalledOnce()
  })

  it('dispose clears listeners and pending timers', () => {
    const cb = vi.fn()
    const t = createAgentStatusTracker()
    t.onChange(cb)
    t.onCommandStart()
    t.dispose()
    cb.mockClear()
    vi.advanceTimersByTime(BLOCKED_TIMEOUT_MS + IDLE_AFTER_BLOCKED_MS)
    expect(cb).not.toHaveBeenCalled()
  })
})
