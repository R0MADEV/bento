import { describe, it, expect } from 'vitest'
import { panelTitlesFromLayout } from '../../../src/core/workspace/panelTitles'

describe('panelTitlesFromLayout', () => {
  it('extracts titles from a serialized layout', () => {
    const layout = { panels: { 'tv-1': { id: 'tv-1', title: 'TV' }, 'terminal-1': { id: 'terminal-1', title: 'Terminal 1' } } }
    expect(panelTitlesFromLayout(layout)).toEqual(['TV', 'Terminal 1'])
  })

  it('falls back to the id when a panel has no title', () => {
    expect(panelTitlesFromLayout({ panels: { 'tv-1': { id: 'tv-1' } } })).toEqual(['tv-1'])
  })

  it('returns [] for missing or malformed layouts', () => {
    expect(panelTitlesFromLayout(null)).toEqual([])
    expect(panelTitlesFromLayout({})).toEqual([])
    expect(panelTitlesFromLayout('nope')).toEqual([])
  })
})
