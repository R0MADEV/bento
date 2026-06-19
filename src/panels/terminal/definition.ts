import type { PanelDefinition } from '../registry'
import { createTerminalPanel } from './TerminalPanel'

export const terminalPanelDefinition: PanelDefinition = {
  type: 'terminal',
  title: 'Terminal',
  create: () => {
    const handle = createTerminalPanel()
    return { element: handle.element, fit: handle.fit, dispose: handle.dispose }
  },
}
