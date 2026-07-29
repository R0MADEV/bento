import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const jiraPanelDefinition: PanelDefinition = {
  type: 'jira',
  title: appT('panelJira'),
  create: () => lazyPanel(async () => {
    const { createJiraPanel } = await import('./JiraPanel')
    return createJiraPanel()
  }),
}
