import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const terminalPanelDefinition: PanelDefinition = {
  type: 'terminal',
  title: 'Terminal',
  create: (ctx) => lazyPanel(async () => {
    const { createTerminalPanel } = await import('./TerminalPanel')
    return createTerminalPanel(ctx.panelId, ctx.projectPath, ctx.removeSelf)
  }),
}
