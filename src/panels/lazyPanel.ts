import type { PanelInstance, PanelApi } from './registry'

// Defers loading a panel's module until it is instantiated: the initial
// bundle doesn't drag in heavy dependencies (xterm, hls.js) from panels the
// user may never open. Returns a container instantly and mounts the real
// panel when its dynamic import() resolves, proxying the contract.
export function lazyPanel(load: () => Promise<PanelInstance>): PanelInstance {
  const element = document.createElement('div')
  element.className = 'panel-lazy'

  let inner: PanelInstance | undefined
  let disposed = false
  let titleCb: ((title: string) => void) | undefined
  let readyApi: PanelApi | undefined

  load().then(instance => {
    if (disposed) { instance.dispose?.(); return }
    inner = instance
    element.replaceChildren(instance.element)
    if (titleCb) instance.onTitleChange?.(titleCb)
    if (readyApi) instance.onReady?.(readyApi)
    instance.fit?.()
  })

  return {
    element,
    fit: () => inner?.fit?.(),
    focus: () => inner?.focus?.(),
    dispose: () => { disposed = true; inner?.dispose?.() },
    // Remembers the callback until the panel loads; then re-registers it.
    onTitleChange: cb => { titleCb = cb; return () => { titleCb = undefined } },
    onReady: api => { readyApi = api; inner?.onReady?.(api) },
    getCwd: () => inner?.getCwd?.(),
  }
}
