import { describe, it, expect } from 'vitest'
import { currentPanelIndex } from '../../../src/core/workspace/currentPanel'

const panels = [
  { id: 'terminal-1' },
  { id: 'terminal-2' },
  { id: 'terminal-3' },
]

const makeEl = (...children: object[]) => {
  const self = { contains: (el: object | null) => el !== null && (el === self || children.includes(el)) }
  return self as unknown as Element
}

describe('currentPanelIndex', () => {
  it('returns index of the panel whose element contains the active element', () => {
    const focused = makeEl()
    const els = [makeEl(), makeEl(focused), makeEl()]
    expect(currentPanelIndex(panels, focused, id => els[panels.findIndex(p => p.id === id)], null)).toBe(1)
  })

  it('falls back to activePanelId when no element contains the active element', () => {
    const els = panels.map(() => makeEl())
    const unrelated = makeEl()
    expect(currentPanelIndex(panels, unrelated, id => els[panels.findIndex(p => p.id === id)], 'terminal-3')).toBe(2)
  })

  it('returns -1 when neither element focus nor activePanelId matches', () => {
    const els = panels.map(() => makeEl())
    const unrelated = makeEl()
    expect(currentPanelIndex(panels, unrelated, id => els[panels.findIndex(p => p.id === id)], 'terminal-99')).toBe(-1)
  })

  it('prefers focus match over activePanelId', () => {
    const focused = makeEl()
    const els = [makeEl(focused), makeEl(), makeEl()]
    expect(currentPanelIndex(panels, focused, id => els[panels.findIndex(p => p.id === id)], 'terminal-3')).toBe(0)
  })

  it('returns -1 when activeElement is null', () => {
    const els = panels.map(() => makeEl())
    expect(currentPanelIndex(panels, null, id => els[panels.findIndex(p => p.id === id)], null)).toBe(-1)
  })
})
