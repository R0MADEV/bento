import { describe, it, expect } from 'vitest'
import { createDefaultLayout } from '../../../src/core/workspace/layout'

describe('createDefaultLayout', () => {
  it('creates exactly two panels', () => {
    const layout = createDefaultLayout()
    expect(layout.panels).toHaveLength(2)
  })

  it('includes a tv panel on the left', () => {
    const layout = createDefaultLayout()
    const tvPanel = layout.panels.find(p => p.type === 'tv')
    expect(tvPanel).toBeDefined()
    expect(tvPanel?.position).toBe('left')
  })

  it('includes a terminal panel on the right', () => {
    const layout = createDefaultLayout()
    const terminalPanel = layout.panels.find(p => p.type === 'terminal')
    expect(terminalPanel).toBeDefined()
    expect(terminalPanel?.position).toBe('right')
  })
})
