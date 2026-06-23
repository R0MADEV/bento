import { describe, it, expect } from 'vitest'
import { noteTitle } from '../../../src/core/notes/noteTitle'

describe('noteTitle', () => {
  it('uses the first non-empty line', () => {
    expect(noteTitle('Lista de la compra\nleche\npan')).toBe('Lista de la compra')
  })

  it('skips leading blank lines and trims', () => {
    expect(noteTitle('\n\n   Reunión lunes   \nnotas')).toBe('Reunión lunes')
  })

  it('falls back to "Nota" when empty or only whitespace', () => {
    expect(noteTitle('')).toBe('Nota')
    expect(noteTitle('   \n  \n')).toBe('Nota')
  })

  it('truncates very long titles with an ellipsis', () => {
    const long = 'x'.repeat(60)
    const out = noteTitle(long)
    expect(out.length).toBeLessThanOrEqual(41)
    expect(out.endsWith('…')).toBe(true)
  })
})
