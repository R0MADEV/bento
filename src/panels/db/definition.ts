import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const dbPanelDefinition: PanelDefinition = {
  type: 'db',
  title: appT('panelDb'),
  create: () => lazyPanel(async () => {
    const { createDbPanel } = await import('./DbPanel')
    return createDbPanel()
  }),
}
