import { describe, it, expect } from 'vitest'
import { initUndo, commit, undo, redo, current } from '../../../src/core/notes/undoStack'

describe('undoStack', () => {
  it('starts with the initial value', () => {
    expect(current(initUndo('hola'))).toBe('hola')
  })

  it('commit adds a new state and moves to it', () => {
    const s = commit(initUndo(''), 'hola')
    expect(current(s)).toBe('hola')
  })

  it('commit ignores an unchanged value', () => {
    const s0 = initUndo('hola')
    expect(commit(s0, 'hola')).toBe(s0)
  })

  it('undo goes back one step, redo forward', () => {
    let s = commit(commit(initUndo(''), 'hola'), 'hola como')
    expect(current(s)).toBe('hola como')
    s = undo(s)
    expect(current(s)).toBe('hola')
    s = undo(s)
    expect(current(s)).toBe('')
    s = redo(s)
    expect(current(s)).toBe('hola')
  })

  it('undo stops at the first state', () => {
    const s = undo(undo(initUndo('x')))
    expect(current(s)).toBe('x')
  })

  it('commit after undo discards the redo branch', () => {
    let s = commit(commit(initUndo(''), 'a'), 'ab') // '', a, ab
    s = undo(s)                                      // at 'a'
    s = commit(s, 'aX')                              // '', a, aX
    expect(current(s)).toBe('aX')
    expect(current(redo(s))).toBe('aX') // no redo branch left
  })
})
