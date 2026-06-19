// Contrato común de todos los paneles de Bento (TV, terminal, radio, notas...).
// Cada tipo de panel se auto-describe y se registra; la app los consume genéricamente.

export interface PanelContext {
  // Id único de la instancia en el layout
  panelId: string
  // Quita este panel del layout (p. ej. cuando se queda vacío)
  removeSelf: () => void
}

export interface PanelInstance {
  element: HTMLElement
  // Re-ajuste al cambiar de tamaño/visibilidad (opcional)
  fit?: () => void
  // Limpieza de recursos al cerrar (opcional)
  dispose?: () => void
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
