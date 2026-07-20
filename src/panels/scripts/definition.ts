import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const scriptsPanelDefinition: PanelDefinition = {
  type: 'scripts',
  title: 'Scripts',
  create: ctx => lazyPanel(async () => {
    const { createScriptsPanel } = await import('./ScriptsPanel')
    return createScriptsPanel(ctx.projectPath)
  }),
}
