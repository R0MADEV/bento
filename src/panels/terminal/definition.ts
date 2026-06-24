import type { PanelDefinition } from '../registry'
import { createTerminalPanel } from './TerminalPanel'

export const terminalPanelDefinition: PanelDefinition = {
  type: 'terminal',
  title: 'Terminal',
  create: (ctx) => createTerminalPanel(ctx.panelId, ctx.projectPath, ctx.removeSelf),
}
