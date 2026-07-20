import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const jiraPanelDefinition: PanelDefinition = {
  type: 'jira',
  title: 'Jira',
  create: () => lazyPanel(async () => {
    const { createJiraPanel } = await import('./JiraPanel')
    return createJiraPanel()
  }),
}
