import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const terminalPanelDefinition: PanelDefinition = {
  type: 'terminal',
  title: appT('panelTerminal'),
  create: (ctx) => lazyPanel(async () => {
    const { createTerminalPanel } = await import('./TerminalPanel')
    return createTerminalPanel(ctx.panelId, ctx.projectPath, ctx.removeSelf)
  }),
}
