import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const scriptsPanelDefinition: PanelDefinition = {
  type: 'scripts',
  title: appT('panelScripts'),
  create: ctx => lazyPanel(async () => {
    const { createScriptsPanel } = await import('./ScriptsPanel')
    return createScriptsPanel(ctx.projectPath)
  }),
}
