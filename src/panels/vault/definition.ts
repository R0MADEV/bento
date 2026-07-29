import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const vaultPanelDefinition: PanelDefinition = {
  type: 'vault',
  title: appT('panelVault'),
  create: () => lazyPanel(async () => {
    const { createVaultPanel } = await import('./VaultPanel')
    return createVaultPanel()
  }),
}
