import type { MemoryRepository } from '../../ports/MemoryRepository'
import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'
import { appT } from '../../core/i18n'

export const memoryPanelDefinition = (repo: MemoryRepository): PanelDefinition => ({
  type: 'memory',
  title: appT('panelMemory'),
  create: ctx => lazyPanel(async () => {
    const { createMemoryPanel } = await import('./MemoryPanel')
    return createMemoryPanel(repo, ctx.projectPath)
  }),
})
