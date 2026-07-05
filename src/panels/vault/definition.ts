import type { PanelDefinition } from '../registry'
import { createVaultPanel } from './VaultPanel'

export const vaultPanelDefinition: PanelDefinition = {
  type: 'vault',
  title: 'Vault',
  singleton: true,
  create: () => createVaultPanel(),
}
