import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'
import type { AgentStore } from '../../core/terminal/agentStore'

export function terminalPanelDefinition(store: AgentStore): PanelDefinition {
  return {
    type: 'terminal',
    title: appT('panelTerminal'),
    create: (ctx) => lazyPanel(async () => {
      const { createTerminalHub } = await import('./terminalHub')
      return createTerminalHub(ctx.panelId, ctx.projectPath ?? '', store)
    }),
  }
}
