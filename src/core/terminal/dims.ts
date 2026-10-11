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

const hasSize = (dims: Dims): boolean => dims.rows > 0 && dims.cols > 0

// A terminal open in several clients (app, CLI, phone) has ONE size, the one
// the daemon reports. Whether this client must ask for its own (`own`) because
// it is the one in use: it has a size and the terminal is not at it already.
export function needsClaim(own: Dims, shared: Dims | null): boolean {
  if (!hasSize(own)) return false
  return shared === null || dimsChanged(shared, own)
}

// The grid to draw: the terminal's real size once the daemon reported it, so
// what an agent paints for another client's size lands in the same cells here.
export function gridToDraw(own: Dims, shared: Dims | null): Dims {
  return shared ?? own
}
