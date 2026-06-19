import type { PanelDef, LayoutDef } from '../../src/core/workspace/Workspace'

export function buildPanel(overrides: Partial<PanelDef> = {}): PanelDef {
  return {
    id: 'panel-1',
    type: 'tv',
    title: 'TV',
    position: 'left',
    ...overrides,
  }
}

export function buildLayout(overrides: Partial<LayoutDef> = {}): LayoutDef {
  return {
    panels: [buildPanel(), buildPanel({ id: 'panel-2', type: 'terminal', position: 'right' })],
    ...overrides,
  }
}
