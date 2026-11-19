import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  release: null as null | (() => void),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    // Lets a test hold the registration open, as a slow IPC round trip would.
    if (mocks.release === null) await new Promise<void>(resolve => { mocks.release = resolve })
    mocks.listeners.set(event, handler)
    return () => mocks.listeners.delete(event)
  }),
}))

import { createListenerScope } from '../../src/adapters/listenerScope'

const registerNow = () => { mocks.release = () => {} }

describe('listener scope', () => {
  beforeEach(() => { mocks.listeners.clear(); mocks.release = null })

  it('resolves once the listener is registered', async () => {
    registerNow()
    const scope = createListenerScope()

    await scope.listen('pty-output-1', vi.fn())

    expect(mocks.listeners.has('pty-output-1')).toBe(true)
  })

  it('drops every listener on close', async () => {
    registerNow()
    const scope = createListenerScope()
    await scope.listen('a', vi.fn())
    await scope.listen('b', vi.fn())

    scope.close()

    expect(mocks.listeners.size).toBe(0)
  })

  it('drops a listener whose registration lands after close', async () => {
    const scope = createListenerScope()
    const registered = scope.listen('pty-title-1', vi.fn())
    await vi.waitFor(() => expect(mocks.release).not.toBeNull())

    scope.close()
    mocks.release?.()
    await registered

    expect(mocks.listeners.has('pty-title-1')).toBe(false)
  })
})
