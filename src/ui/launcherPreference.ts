// Where the panel launcher dock sits: left (default), right, top or bottom.
// Persisted. Nesting the launcher outside the session content means it simply
// stacks with the session bar — no collision handling needed.

export type LauncherPosition = 'left' | 'right' | 'top' | 'bottom'

export const LAUNCHER_POSITIONS: LauncherPosition[] = ['left', 'right', 'top', 'bottom']

const KEY = 'bento.launcher.position'
const EVENT = 'bento:launcher-position'

export function parseLauncherPosition(raw: string | null): LauncherPosition {
  return LAUNCHER_POSITIONS.includes(raw as LauncherPosition) ? (raw as LauncherPosition) : 'left'
}

export function getLauncherPosition(): LauncherPosition {
  return parseLauncherPosition(localStorage.getItem(KEY))
}

export function setLauncherPosition(pos: LauncherPosition): void {
  localStorage.setItem(KEY, pos)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: pos }))
}

// Subscribe to position changes. Returns the unsubscribe function.
export function onLauncherPositionChange(handler: () => void): () => void {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

// ── Collapsed state ──────────────────────────────────────────────────────────

const KEY_COLLAPSED = 'bento.launcher.collapsed'
const EVENT_COLLAPSED = 'bento:launcher-collapsed'

export function getLauncherCollapsed(): boolean {
  return localStorage.getItem(KEY_COLLAPSED) === '1'
}

export function setLauncherCollapsed(on: boolean): void {
  localStorage.setItem(KEY_COLLAPSED, on ? '1' : '0')
  window.dispatchEvent(new CustomEvent(EVENT_COLLAPSED))
}

export function toggleLauncherCollapsed(): void {
  setLauncherCollapsed(!getLauncherCollapsed())
}

export function onLauncherCollapsedChange(handler: () => void): () => void {
  window.addEventListener(EVENT_COLLAPSED, handler)
  return () => window.removeEventListener(EVENT_COLLAPSED, handler)
}
