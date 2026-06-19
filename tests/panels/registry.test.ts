import { describe, it, expect } from 'vitest'
import { createPanelRegistry } from '../../src/panels/registry'
import type { PanelDefinition } from '../../src/panels/registry'

const fakePanel = (type: string): PanelDefinition => ({
  type,
  title: type.toUpperCase(),
  create: () => ({ element: document.createElement('div') }),
})

describe('panel registry', () => {
  it('registers and retrieves a panel by type', () => {
    const registry = createPanelRegistry()
    registry.register(fakePanel('tv'))
    expect(registry.get('tv')?.title).toBe('TV')
  })

  it('returns undefined for unknown types', () => {
    const registry = createPanelRegistry()
    expect(registry.get('nope')).toBeUndefined()
  })

  it('lists all registered panels in registration order', () => {
    const registry = createPanelRegistry()
    registry.register(fakePanel('tv'))
    registry.register(fakePanel('terminal'))
    expect(registry.list().map(d => d.type)).toEqual(['tv', 'terminal'])
  })

  it('re-registering a type overwrites the previous definition', () => {
    const registry = createPanelRegistry()
    registry.register(fakePanel('tv'))
    registry.register({ ...fakePanel('tv'), title: 'Televisión' })
    expect(registry.get('tv')?.title).toBe('Televisión')
    expect(registry.list()).toHaveLength(1)
  })
})
