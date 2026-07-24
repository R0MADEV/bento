import { describe, it, expect } from 'vitest'
import { expandInput, SLASH_COMMANDS } from '../../../src/core/ai/prompts'

describe('expandInput', () => {
  it('leaves plain text untouched', () => {
    expect(expandInput('hola qué tal')).toBe('hola qué tal')
  })

  it('leaves unknown slash commands untouched', () => {
    expect(expandInput('/desconocido algo')).toBe('/desconocido algo')
  })

  it('expands a known command with its argument', () => {
    const out = expandInput('/traducir hola mundo')
    expect(out).toContain('Traduce al inglés')
    expect(out).toContain('hola mundo')
  })

  it('handles a command with multiline argument', () => {
    const out = expandInput('/explica\nlínea 1\nlínea 2')
    expect(out).toContain('línea 1\nlínea 2')
  })

  it('every command produces a non-empty prompt', () => {
    SLASH_COMMANDS.forEach(c => {
      expect(c.expand('x').length).toBeGreaterThan(0)
    })
  })
})
