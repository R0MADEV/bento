import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const webPanelDefinition: PanelDefinition = {
  type: 'web',
  title: 'Web',
  create: () => lazyPanel(async () => {
    const { createWebPanel } = await import('./WebPanel')
    return createWebPanel()
  }),
}
