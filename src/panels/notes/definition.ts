import type { PanelDefinition } from '../registry'
import { createNotesPanel } from './NotesPanel'

export const notesPanelDefinition: PanelDefinition = {
  type: 'notes',
  title: 'Notas',
  create: () => createNotesPanel(),
}
