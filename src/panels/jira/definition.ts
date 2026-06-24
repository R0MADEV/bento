import type { PanelDefinition } from '../registry'
import { createJiraPanel } from './JiraPanel'

export const jiraPanelDefinition: PanelDefinition = {
  type: 'jira',
  title: 'Jira',
  create: () => createJiraPanel(),
}
