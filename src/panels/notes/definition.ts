import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const notesPanelDefinition: PanelDefinition = {
  type: 'notes',
  title: appT('panelNotes'),
  create: () => lazyPanel(async () => {
    const { createNotesPanel } = await import('./NotesPanel')
    return createNotesPanel()
  }),
}
