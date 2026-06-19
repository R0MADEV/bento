import type { PanelType } from './types'

interface PanelDef {
  id: string
  type: PanelType
  title: string
  position: 'left' | 'right'
}

interface LayoutDef {
  panels: PanelDef[]
}

export function createDefaultLayout(): LayoutDef {
  return {
    panels: [
      { id: 'tv-1', type: 'tv', title: 'TV', position: 'left' },
      { id: 'terminal-1', type: 'terminal', title: 'Terminal', position: 'right' },
    ],
  }
}
