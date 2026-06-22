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
