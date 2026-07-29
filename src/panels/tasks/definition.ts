import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const tasksPanelDefinition: PanelDefinition = {
  type: 'tasks',
  title: appT('panelTasks'),
  create: (ctx) => lazyPanel(async () => {
    const { createTasksPanel } = await import('./TasksPanel')
    return createTasksPanel(ctx.panelId)
  }),
}
