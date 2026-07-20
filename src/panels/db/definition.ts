import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const dbPanelDefinition: PanelDefinition = {
  type: 'db',
  title: 'Bases de datos',
  create: () => lazyPanel(async () => {
    const { createDbPanel } = await import('./DbPanel')
    return createDbPanel()
  }),
}
