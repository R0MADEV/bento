import type { MemoryRepository } from '../../ports/MemoryRepository'
import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export const memoryPanelDefinition = (repo: MemoryRepository): PanelDefinition => ({
  type: 'memory',
  title: 'Memoria',
  create: ctx => lazyPanel(async () => {
    const { createMemoryPanel } = await import('./MemoryPanel')
    return createMemoryPanel(repo, ctx.projectPath)
  }),
})
