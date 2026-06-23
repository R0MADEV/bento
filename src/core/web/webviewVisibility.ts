export interface VisibilitySnapshot {
  // From an IntersectionObserver — also false when an ancestor is display:none
  intersecting: boolean
  // Computed style of the placeholder; visibility inherits, so a hidden session
  // (visibility:hidden) propagates here even though the element keeps its box.
  visibility: string
  display: string
  opacity: string
  // A DOM overlay (session popover, menu) is shown and must appear above the
  // webview — the native layer always paints over the DOM, so we hide it.
  suppressed: boolean
}

export function isWebviewVisible(s: VisibilitySnapshot): boolean {
  if (s.suppressed) return false
  if (!s.intersecting) return false
  if (s.visibility === 'hidden') return false
  if (s.display === 'none') return false
  return Number(s.opacity) > 0
}
