import { icon } from './helpers/icons'
import { createHorizontalResizablePane } from './resizablePane'
import { appT } from '../core/i18n'

export interface MiniItem {
  label: string           // tooltip text
  dot?: string            // optional data-* value for CSS status colour
  active?: boolean
  onClick?: () => void
}

export interface CollapsibleSidebarOptions {
  storageKey: string      // prefix for localStorage: `${storageKey}.collapsed` / `.width`
  title: string
  defaultWidth?: number   // px, default 220
  minWidth?: number       // px
  minRemaining?: number   // px of detail area to keep
  container?: HTMLElement // parent for width-constraint during resize; defaults to element.parentElement
  onToggle?: (collapsed: boolean) => void
}

export interface CollapsibleSidebarHandle {
  element: HTMLElement    // the sidebar div
  resizer: HTMLElement    // the drag handle (insert after element)
  actions: HTMLElement    // slot for header action buttons (next to the toggle)
  list: HTMLElement       // slot for the list content
  footer: HTMLElement     // slot for the footer actions
  mini: HTMLElement       // slot for mini indicators (visible when collapsed)
  toggle: () => void
  setMiniItems: (items: MiniItem[]) => void
}

export const collapsedKey = (storageKey: string): string => `${storageKey}.collapsed`
export const widthKey = (storageKey: string): string => `${storageKey}.width`

export function createCollapsibleSidebar(opts: CollapsibleSidebarOptions): CollapsibleSidebarHandle {
  const { storageKey, title, defaultWidth = 220, minWidth = 160, minRemaining = 320 } = opts

  const ck = collapsedKey(storageKey)
  const wk = widthKey(storageKey)

  const savedWidth = Number(localStorage.getItem(wk))
  const initialWidth = Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : defaultWidth
  let collapsed = localStorage.getItem(ck) === '1'

  // ── Element ──────────────────────────────────────────────────────
  const element = document.createElement('div')
  element.className = 'cs-sidebar'
  if (collapsed) element.classList.add('collapsed')
  element.style.width = `${initialWidth}px`

  // ── Header (title + toggle) ──────────────────────────────────────
  const header = document.createElement('div')
  header.className = 'cs-sidebar-header'

  const titleEl = document.createElement('span')
  titleEl.className = 'cs-sidebar-title'
  titleEl.textContent = title

  // Optional header action buttons (filled by the caller), sit right of the
  // title and left of the toggle.
  const actions = document.createElement('div')
  actions.className = 'cs-sidebar-actions'

  const toggleBtn = document.createElement('button')
  toggleBtn.type = 'button'
  toggleBtn.className = 'cs-sidebar-toggle'
  toggleBtn.title = appT(collapsed ? 'expand' : 'collapse')
  toggleBtn.innerHTML = icon('chevron')

  header.append(titleEl, actions, toggleBtn)

  // ── Mini indicators (collapsed only) ────────────────────────────
  const mini = document.createElement('div')
  mini.className = 'cs-sidebar-mini'

  // ── List slot ───────────────────────────────────────────────────
  const list = document.createElement('div')
  list.className = 'cs-sidebar-list'

  // ── Footer slot ─────────────────────────────────────────────────
  const footer = document.createElement('div')
  footer.className = 'cs-sidebar-footer'

  element.append(header, mini, list, footer)

  // ── Resizer ──────────────────────────────────────────────────────
  const resizerHandle = createHorizontalResizablePane({
    target: element,
    container: opts.container ?? element.parentElement ?? document.body,
    initialWidth,
    minWidth,
    minRemaining,
    onWidthChange: w => localStorage.setItem(wk, String(Math.round(w))),
  })
  if (collapsed) resizerHandle.element.classList.add('hidden')

  // ── Toggle logic ─────────────────────────────────────────────────
  const toggle = (): void => {
    collapsed = !collapsed
    element.classList.toggle('collapsed', collapsed)
    resizerHandle.element.classList.toggle('hidden', collapsed)
    localStorage.setItem(ck, collapsed ? '1' : '0')
    toggleBtn.title = appT(collapsed ? 'expand' : 'collapse')
    opts.onToggle?.(collapsed)
  }
  toggleBtn.addEventListener('click', toggle)

  // ── Mini items ───────────────────────────────────────────────────
  const setMiniItems = (items: MiniItem[]): void => {
    mini.replaceChildren()
    for (const item of items) {
      const wrap = document.createElement('div')
      wrap.className = `cs-mini-wrap${item.active ? ' active' : ''}`
      wrap.title = item.label
      const dot = document.createElement('span')
      dot.className = 'cs-mini-dot'
      if (item.dot) dot.dataset.dot = item.dot
      wrap.appendChild(dot)
      if (item.onClick) wrap.addEventListener('click', item.onClick)
      mini.appendChild(wrap)
    }
  }

  return { element, resizer: resizerHandle.element, actions, list, footer, mini, toggle, setMiniItems }
}
