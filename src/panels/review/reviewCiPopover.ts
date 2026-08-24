import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getUiZoom, toLayoutPixels } from '../../ui/helpers/zoom'
import { esc } from './reviewFormat'

export type StatusCheck = {
  name?: string
  workflowName?: string
  conclusion?: string | null
  state?: string
  context?: string
  targetUrl?: string
}

// El desplegable con el estado de los checks de CI, anclado al badge que lo
// abre. Vive fuera del panel porque solo necesita el rollup y un ancla.
export function showReviewCiPopover(root: HTMLElement, checks: StatusCheck[], anchor: HTMLElement): void {
    root.querySelectorAll('.review-ci-popover').forEach(el => el.remove())
    if (!checks.length) return
    const popover = document.createElement('div')
    popover.className = 'review-ci-popover'
    popover.append(...checks.map(c => {
      const name = c.name ?? c.workflowName ?? c.context ?? 'Check'
      const val = (c.conclusion ?? c.state ?? '').toUpperCase()
      const ok = val === 'SUCCESS' || val === 'COMPLETED'
      const fail = ['FAILURE','ERROR','TIMED_OUT','CANCELLED'].includes(val)
      const item = document.createElement('div')
      item.className = 'review-ci-check'
      item.innerHTML = `<span class="review-ci-check-icon ${ok ? 'ci-ok' : fail ? 'ci-fail' : 'ci-pending'}">${ok ? '✓' : fail ? '✗' : '⟳'}</span><span class="review-ci-check-name">${esc(name)}</span>`
      if (c.targetUrl) {
        item.style.cursor = 'pointer'
        item.addEventListener('click', () => openUrl(c.targetUrl!).catch(() => {}))
      }
      return item
    }))
    const anchorRect = anchor.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const zoom = getUiZoom()
    popover.style.top = `${toLayoutPixels(anchorRect.bottom - rootRect.top, zoom) + 4}px`
    popover.style.left = `${toLayoutPixels(anchorRect.left - rootRect.left, zoom)}px`
    root.append(popover)
    const close = (e: MouseEvent): void => {
      if (!popover.contains(e.target as Node)) { popover.remove(); document.removeEventListener('click', close) }
    }
    setTimeout(() => document.addEventListener('click', close), 0)
  }
