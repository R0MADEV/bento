// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => 256 * 1024 * 1024),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createAgentStatusBar } from '../../src/ui/agentStatusBar'

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

describe('agent status bar memory polling lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    invokeMock.mockClear()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('keeps one scheduled refresh across visibility changes and cancels it on dispose', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const bar = createAgentStatusBar({ onOpenAgents: () => {} })
    await settle()
    expect(vi.getTimerCount()).toBe(1)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(vi.getTimerCount()).toBe(1)

    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(vi.getTimerCount()).toBe(1)

    bar.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
