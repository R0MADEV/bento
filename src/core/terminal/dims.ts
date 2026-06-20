// Terminal size in cells. Forwarding a resize to the PTY emits SIGWINCH, which
// makes TUIs (Ink, etc.) repaint entirely → flicker. So we only forward when
// the dimensions actually change.

export interface Dims {
  rows: number
  cols: number
}

export function dimsChanged(prev: Dims, next: Dims): boolean {
  return prev.rows !== next.rows || prev.cols !== next.cols
}
