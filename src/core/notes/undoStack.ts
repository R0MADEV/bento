// A manual undo history for the notes editor. Tauri's WebView coalesces all typing
// into a single native undo step, so we keep our own word-granular history.
export interface UndoState {
  stack: string[]
  pos: number
}

export function initUndo(value: string): UndoState {
  return { stack: [value], pos: 0 }
}

export function commit(s: UndoState, value: string): UndoState {
  if (value === s.stack[s.pos]) return s
  const stack = [...s.stack.slice(0, s.pos + 1), value]
  return { stack, pos: stack.length - 1 }
}

export function undo(s: UndoState): UndoState {
  return s.pos > 0 ? { ...s, pos: s.pos - 1 } : s
}

export function redo(s: UndoState): UndoState {
  return s.pos < s.stack.length - 1 ? { ...s, pos: s.pos + 1 } : s
}

export function current(s: UndoState): string {
  return s.stack[s.pos]
}
