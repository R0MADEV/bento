import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const tasksPanelDefinition: PanelDefinition = {
  type: 'tasks',
  title: 'Tareas',
  create: () => lazyPanel(async () => {
    const { createTasksPanel } = await import('./TasksPanel')
    return createTasksPanel()
  }),
}
