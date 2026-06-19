// Workspace configuration types

export type PanelType = 'tv' | 'terminal' | 'notes'

export interface Tab {
  id: string
  label: string
  state?: Record<string, unknown>
}

export interface Panel {
  id: string
  type: PanelType
  tabs: Tab[]
  activeTabId: string
}

export interface Window {
  id: string
  panels: Panel[]
  layout: 'vertical' | 'horizontal'
}

export interface WorkspaceConfig {
  id: string
  name: string
  windows: Window[]
  floatingWindows: Window[]
  createdAt: number
  updatedAt: number
}
