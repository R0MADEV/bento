import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const webPanelDefinition: PanelDefinition = {
  type: 'web',
  title: appT('panelWeb'),
  create: () => lazyPanel(async () => {
    const { createWebPanel } = await import('./WebPanel')
    return createWebPanel()
  }),
}
