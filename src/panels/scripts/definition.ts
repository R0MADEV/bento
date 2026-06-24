import type { PanelDefinition } from '../registry'
import { createScriptsPanel } from './ScriptsPanel'

export const scriptsPanelDefinition: PanelDefinition = {
  type: 'scripts',
  title: 'Scripts',
  create: ctx => createScriptsPanel(ctx.projectPath),
}
