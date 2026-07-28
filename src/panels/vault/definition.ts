import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const vaultPanelDefinition: PanelDefinition = {
  type: 'vault',
  title: 'Vault',
  create: () => lazyPanel(async () => {
    const { createVaultPanel } = await import('./VaultPanel')
    return createVaultPanel()
  }),
}
