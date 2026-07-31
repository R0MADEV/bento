import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const diffPanelDefinition: PanelDefinition = {
  type: 'diff',
  title: appT('panelDiff'),
  create: ctx => lazyPanel(async () => {
    const { createDiffPanel } = await import('./DiffPanel')
    return createDiffPanel(ctx.projectPath)
  }),
}
