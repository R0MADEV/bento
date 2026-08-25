import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { t as i18nT } from '../../i18n'

export const remotePanelDefinition: PanelDefinition = {
  type: 'remote',
  title: i18nT('remote.panelTitle'),
  create: () => lazyPanel(async () => {
    const { createPhonePanel } = await import('./PhonePanel')
    return createPhonePanel()
  }),
}
