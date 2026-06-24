import type { PanelDefinition } from '../registry'
import { createDbPanel } from './DbPanel'

export const dbPanelDefinition: PanelDefinition = {
  type: 'db',
  title: 'Bases de datos',
  create: () => createDbPanel(),
}
