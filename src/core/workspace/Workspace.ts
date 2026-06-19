export type PanelType = 'tv' | 'terminal' | 'notes'

export interface PanelDef {
  id: string
  type: PanelType
  title: string
  position: 'left' | 'right'
}

export interface LayoutDef {
  panels: PanelDef[]
}
