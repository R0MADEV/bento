import type { PanelDefinition } from '../registry'
import { createWebPanel } from './WebPanel'

export const webPanelDefinition: PanelDefinition = {
  type: 'web',
  title: 'Web',
  create: () => createWebPanel(),
}
