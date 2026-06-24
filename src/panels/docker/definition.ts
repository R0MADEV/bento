import type { PanelDefinition } from '../registry'
import { createDockerPanel } from './DockerPanel'

export const dockerPanelDefinition: PanelDefinition = {
  type: 'docker',
  title: 'Docker',
  create: () => createDockerPanel(),
}
