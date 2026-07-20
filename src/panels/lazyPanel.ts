import type { PanelInstance, PanelApi } from './registry'

// Difiere la carga del módulo de un panel hasta que se instancia: el bundle
// inicial no arrastra dependencias pesadas (xterm, hls.js) de paneles que el
// usuario quizá nunca abra. Devuelve un contenedor al instante y monta el
// panel real cuando su import() dinámico resuelve, proxyando el contrato.
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
    // Recuerda el callback hasta que el panel cargue; entonces lo re-registra.
    onTitleChange: cb => { titleCb = cb; return () => { titleCb = undefined } },
    onReady: api => { readyApi = api; inner?.onReady?.(api) },
    getCwd: () => inner?.getCwd?.(),
  }
}
