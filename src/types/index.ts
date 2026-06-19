// Re-exports de todos los tipos públicos del proyecto.
// Importar desde aquí cuando se necesiten tipos en más de un módulo.

export type { Channel, Stream } from '../core/channel/Channel'
export type { PanelType, PanelDef, LayoutDef } from '../core/workspace/Workspace'
export type { ChannelRepository } from '../ports/ChannelRepository'
