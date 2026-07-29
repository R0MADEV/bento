import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const dockerPanelDefinition: PanelDefinition = {
  type: 'docker',
  title: appT('panelDocker'),
  create: () => lazyPanel(async () => {
    const { createDockerPanel } = await import('./DockerPanel')
    return createDockerPanel()
  }),
}
