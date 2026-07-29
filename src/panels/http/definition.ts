import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const httpPanelDefinition: PanelDefinition = {
  type: 'http',
  title: appT('panelHttp'),
  create: ctx => lazyPanel(async () => {
    const { createHttpPanel } = await import('./HttpPanel')
    return createHttpPanel(ctx.panelId)
  }),
}
