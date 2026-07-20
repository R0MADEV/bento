// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { lazyPanel } from '../../src/panels/lazyPanel'
import type { PanelInstance } from '../../src/panels/registry'

const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('lazyPanel', () => {
  it('returns a container element synchronously, before the module loads', () => {
    const instance = lazyPanel(() => new Promise<PanelInstance>(() => {}))
    expect(instance.element).toBeInstanceOf(HTMLElement)
  })

  it('mounts the real panel element inside the container once loaded', async () => {
    const inner = document.createElement('section')
    const instance = lazyPanel(async () => ({ element: inner }))
    await flush()
    expect(instance.element.contains(inner)).toBe(true)
  })

  it('proxies fit/focus/getCwd to the loaded panel', async () => {
    const fit = vi.fn()
    const focus = vi.fn()
    const instance = lazyPanel(async () => ({
      element: document.createElement('div'),
      fit,
      focus,
      getCwd: () => '/home/roma',
    }))
    // Before load: no-op, never throws
    instance.fit?.()
    expect(instance.getCwd?.()).toBeUndefined()

    await flush()
    instance.fit?.()
    instance.focus?.()
    expect(fit).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    expect(instance.getCwd?.()).toBe('/home/roma')
  })

  it('replays onTitleChange and onReady registered before load', async () => {
    const onTitleChange = vi.fn(() => () => {})
    const onReady = vi.fn()
    const instance = lazyPanel(async () => ({
      element: document.createElement('div'),
      onTitleChange,
      onReady,
    }))
    const titleCb = vi.fn()
    instance.onTitleChange?.(titleCb)
    instance.onReady?.({ maximize() {}, exitMaximized() {}, isMaximized: () => false })

    await flush()
    expect(onTitleChange).toHaveBeenCalledWith(titleCb)
    expect(onReady).toHaveBeenCalled()
  })

  it('disposes the loaded panel if disposed after load', async () => {
    const dispose = vi.fn()
    const instance = lazyPanel(async () => ({ element: document.createElement('div'), dispose }))
    await flush()
    instance.dispose?.()
    expect(dispose).toHaveBeenCalled()
  })

  it('disposes an instance that resolves after the panel was already disposed', async () => {
    const dispose = vi.fn()
    let resolve!: (i: PanelInstance) => void
    const instance = lazyPanel(() => new Promise<PanelInstance>(r => { resolve = r }))
    instance.dispose?.()
    resolve({ element: document.createElement('div'), dispose })
    await flush()
    expect(dispose).toHaveBeenCalled()
  })
})
