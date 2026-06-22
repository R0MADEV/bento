// Where the session bar sits: top (default), bottom, left or right. Persisted.

export type BarPosition = 'top' | 'bottom' | 'left' | 'right'

export const BAR_POSITIONS: BarPosition[] = ['top', 'bottom', 'left', 'right']

const KEY = 'bento.sessionBar.position'
const EVENT = 'bento:session-bar-position'

export function parseBarPosition(raw: string | null): BarPosition {
  return BAR_POSITIONS.includes(raw as BarPosition) ? (raw as BarPosition) : 'top'
}

export function getBarPosition(): BarPosition {
  return parseBarPosition(localStorage.getItem(KEY))
}

export function setBarPosition(pos: BarPosition): void {
  localStorage.setItem(KEY, pos)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: pos }))
}

// Subscribe to position changes. Returns the unsubscribe function.
export function onBarPositionChange(handler: () => void): () => void {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

// ── Collapsed state ──────────────────────────────────────────────────────────

const KEY_COLLAPSED = 'bento.sessionBar.collapsed'
const EVENT_COLLAPSED = 'bento:session-bar-collapsed'

export function getBarCollapsed(): boolean {
  return localStorage.getItem(KEY_COLLAPSED) === '1'
}

export function setBarCollapsed(on: boolean): void {
  localStorage.setItem(KEY_COLLAPSED, on ? '1' : '0')
  window.dispatchEvent(new CustomEvent(EVENT_COLLAPSED))
}

export function toggleBarCollapsed(): void {
  setBarCollapsed(!getBarCollapsed())
}

export function onBarCollapsedChange(handler: () => void): () => void {
  window.addEventListener(EVENT_COLLAPSED, handler)
  return () => window.removeEventListener(EVENT_COLLAPSED, handler)
}
