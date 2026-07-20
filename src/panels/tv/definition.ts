import type { ChannelRepository } from '../../ports/ChannelRepository'
import type { FavoritesRepository } from '../../ports/FavoritesRepository'
import type { PanelDefinition } from '../registry'
import { lazyPanel } from '../lazyPanel'

export function tvPanelDefinition(
  repo: ChannelRepository,
  favoritesRepo: FavoritesRepository,
  worldRepo?: ChannelRepository
): PanelDefinition {
  return {
    type: 'tv',
    title: 'TV',
    // Playing two TVs at once makes no sense; the user can unlock multiples.
    singleton: true,
    create: () => lazyPanel(async () => {
      const { createTVPanel } = await import('./TVPanel')
      return { element: createTVPanel(repo, favoritesRepo, worldRepo) }
    }),
  }
}
