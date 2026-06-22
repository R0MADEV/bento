// DEC mode 2026 (Synchronized Output): apps like catunes (Ink) bracket each
// frame in ESC[?2026h ... ESC[?2026l so the terminal shows whole frames, never
// a half-erased intermediate state. xterm.js 5.3 ignores mode 2026, so handing
// it a partial frame causes flicker. We buffer until a frame closes and write
// complete frames atomically.

const BEGIN = '\x1b[?2026h'
const END = '\x1b[?2026l'
const COMMON = '\x1b[?2026' // shared prefix of BEGIN/END

// Length of a trailing, still-incomplete sync marker prefix (so we don't split
// a marker across writes). 0 if the buffer doesn't end mid-marker.
function trailingMarkerPrefix(buf: string): number {
  for (let k = COMMON.length; k >= 1; k--) {
    if (buf.endsWith(COMMON.slice(0, k))) return k
  }
  return 0
}

// Splits the buffer into the part safe to write now (only complete frames) and
// the part to keep buffering (an open or partial sync block at the end).
export function splitAtSyncBoundary(buf: string): { flush: string; keep: string } {
  const lastBegin = buf.lastIndexOf(BEGIN)
  const insideOpenBlock = lastBegin !== -1 && buf.indexOf(END, lastBegin + BEGIN.length) === -1
  if (insideOpenBlock) return { flush: buf.slice(0, lastBegin), keep: buf.slice(lastBegin) }

  const partial = trailingMarkerPrefix(buf)
  if (partial === 0) return { flush: buf, keep: '' }
  return { flush: buf.slice(0, buf.length - partial), keep: buf.slice(buf.length - partial) }
}
