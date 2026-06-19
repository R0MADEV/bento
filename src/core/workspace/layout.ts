import type { LayoutDef } from './Workspace'

export function createDefaultLayout(): LayoutDef {
  return {
    panels: [
      { id: 'tv-1', type: 'tv', title: 'TV', position: 'left' },
      { id: 'terminal-1', type: 'terminal', title: 'Terminal', position: 'right' },
    ],
  }
}
