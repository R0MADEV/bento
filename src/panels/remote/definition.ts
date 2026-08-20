import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const remotePanelDefinition: PanelDefinition = {
  type: 'remote',
  title: 'Móvil',
  create: () => lazyPanel(async () => {
    const { createPhonePanel } = await import('./PhonePanel')
    return createPhonePanel()
  }),
}
