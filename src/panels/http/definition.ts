import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const httpPanelDefinition: PanelDefinition = {
  type: 'http',
  title: 'HTTP',
  create: ctx => lazyPanel(async () => {
    const { createHttpPanel } = await import('./HttpPanel')
    return createHttpPanel(ctx.panelId)
  }),
}
