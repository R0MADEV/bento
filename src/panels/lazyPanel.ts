import type { PanelInstance, PanelApi } from './registry'
import { t as i18nT } from '../i18n'

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
  let pendingVisibility: boolean | undefined

  load().then(instance => {
    if (disposed) { instance.dispose?.(); return }
    inner = instance
    element.replaceChildren(instance.element)
    if (titleCb) instance.onTitleChange?.(titleCb)
    if (readyApi) instance.onReady?.(readyApi)
    // If the panel was hidden while its module was still loading, apply the
    // last known visibility now so it doesn't start active while off-screen.
    if (pendingVisibility === false) instance.onVisibilityChange?.(false)
    instance.fit?.()
  }).catch(error => {
    if (disposed) return
    element.classList.add('panel-load-error')
    element.textContent = `${i18nT('common.couldNotLoadPanel')}${String(error)}`
  })

  return {
    element,
    fit: () => inner?.fit?.(),
    focus: () => inner?.focus?.(),
    dispose: () => { disposed = true; inner?.dispose?.() },
    // Remembers the callback until the panel loads; then re-registers it.
    onTitleChange: cb => { titleCb = cb; return () => { titleCb = undefined } },
    onReady: api => { readyApi = api; inner?.onReady?.(api) },
    onVisibilityChange: (visible) => {
      pendingVisibility = visible
      inner?.onVisibilityChange?.(visible)
    },
    getCwd: () => inner?.getCwd?.(),
  }
}
