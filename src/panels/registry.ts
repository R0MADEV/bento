// Common contract for all Bento panels (TV, terminal, radio, notes...).
// Each panel type self-describes and registers itself; the app consumes them generically.

export interface PanelContext {
  // Unique id of the instance in the layout
  panelId: string
  // Removes this panel from the layout (e.g. when it becomes empty)
  removeSelf: () => void
  // The session's project folder; new terminals start here
  projectPath?: string
  // Opens a new panel of the same type in the same group
  newSibling?: () => void
}

export interface PanelApi {
  maximize(): void
  exitMaximized(): void
  isMaximized(): boolean
}

export interface PanelInstance {
  element: HTMLElement
  fit?: () => void
  focus?: () => void
  dispose?: () => void
  onTitleChange?: (cb: (title: string) => void) => () => void
  onReady?: (api: PanelApi) => void
  onVisibilityChange?: (visible: boolean) => void
  // Current working directory (terminals report it via OSC 7)
  getCwd?: () => string | undefined
}

export interface PanelDefinition {
  type: string
  title: string
  create: (ctx: PanelContext) => PanelInstance
}

export interface PanelRegistry {
  register: (def: PanelDefinition) => void
  get: (type: string) => PanelDefinition | undefined
  list: () => PanelDefinition[]
}

export function createPanelRegistry(): PanelRegistry {
  const definitions = new Map<string, PanelDefinition>()
  return {
    register: def => { definitions.set(def.type, def) },
    get: type => definitions.get(type),
    list: () => [...definitions.values()],
  }
}
