import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const reviewPanelDefinition: PanelDefinition = {
  type: 'review',
  title: appT('panelReview'),
  create: ctx => lazyPanel(async () => {
    const { createReviewPanel } = await import('./ReviewPanel')
    return createReviewPanel(ctx.projectPath)
  }),
}
