import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const dockerPanelDefinition: PanelDefinition = {
  type: 'docker',
  title: 'Docker',
  create: () => lazyPanel(async () => {
    const { createDockerPanel } = await import('./DockerPanel')
    return createDockerPanel()
  }),
}
