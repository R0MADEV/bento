import type { PanelDefinition } from '../registry'
import { appT } from '../../core/i18n'

export function agentsPanelDefinition(): PanelDefinition {
  return {
    type: 'terminal',
    title: appT('panelTerminal'),
    create: (ctx) => {
      let panel: { element: HTMLElement; fit: () => void; dispose: () => void } | undefined
      const wrapper = document.createElement('div')
      wrapper.className = 'panel-lazy agents-hub-wrapper'

      import('./AgentsPanel').then(({ createAgentsPanel }) => {
        panel = createAgentsPanel(ctx.projectPath ?? '')
        wrapper.replaceChildren(panel.element)
        panel.fit()
      }).catch(() => {})

      return {
        element: wrapper,
        fit: () => panel?.fit(),
        dispose: () => panel?.dispose(),
      }
    },
  }
}
