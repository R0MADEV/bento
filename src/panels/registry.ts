// Contrato común de todos los paneles de Bento (TV, terminal, radio, notas...).
// Cada tipo de panel se auto-describe y se registra; la app los consume genéricamente.

export interface PanelContext {
  // Id único de la instancia en el layout
  panelId: string
  // Quita este panel del layout (p. ej. cuando se queda vacío)
  removeSelf: () => void
  // Carpeta del proyecto de la sesión; las terminales nuevas arrancan aquí
  projectPath?: string
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
  // Current working directory (terminals report it via OSC 7)
  getCwd?: () => string | undefined
}

export interface PanelDefinition {
  type: string
  title: string
  // Only one instance allowed by default (the user can unlock multiples).
  singleton?: boolean
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
