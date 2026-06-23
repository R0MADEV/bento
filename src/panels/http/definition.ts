import type { PanelDefinition } from '../registry'
import { createHttpPanel } from './HttpPanel'

export const httpPanelDefinition: PanelDefinition = {
  type: 'http',
  title: 'HTTP',
  create: ctx => createHttpPanel(ctx.panelId),
}
