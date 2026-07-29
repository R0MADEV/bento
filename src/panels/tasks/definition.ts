import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const tasksPanelDefinition: PanelDefinition = {
  type: 'tasks',
  title: 'Tareas',
  create: (ctx) => lazyPanel(async () => {
    const { createTasksPanel } = await import('./TasksPanel')
    return createTasksPanel(ctx.panelId)
  }),
}
