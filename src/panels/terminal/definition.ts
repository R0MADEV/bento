import type { PanelDefinition } from '../registry'
import { createTerminalPanel } from './TerminalPanel'

export const terminalPanelDefinition: PanelDefinition = {
  type: 'terminal',
  title: 'Terminal',
  create: (ctx) => {
    const handle = createTerminalPanel(ctx.panelId, ctx.projectPath)
    return { element: handle.element, fit: handle.fit, focus: handle.focus, dispose: handle.dispose, onTitleChange: handle.onTitleChange, onReady: handle.onReady, getCwd: handle.getCwd }
  },
}
