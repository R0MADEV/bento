import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const notesPanelDefinition: PanelDefinition = {
  type: 'notes',
  title: 'Notas',
  create: () => lazyPanel(async () => {
    const { createNotesPanel } = await import('./NotesPanel')
    return createNotesPanel()
  }),
}
