import type { ChannelRepository } from '../../ports/ChannelRepository'
import { filterChannels } from '../../core/channel/filterChannels'
import type { Channel } from '../../core/channel/Channel'
import { renderGrid } from './grid'
import { HLSPlayer } from './player'

export function createTVPanel(repo: ChannelRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'tv-panel'

  const toolbar = document.createElement('div')
  toolbar.className = 'tv-toolbar'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Buscar canal...'
  input.className = 'tv-search'
  toolbar.appendChild(input)

  const grid = document.createElement('div')
  grid.className = 'tv-grid'

  const player = new HLSPlayer()

  root.appendChild(toolbar)
  root.appendChild(grid)
  root.appendChild(player.element)

  let allChannels: Channel[] = []

  const refresh = (query: string) =>
    renderGrid(grid, filterChannels(allChannels, query), ch => player.play(ch))

  input.addEventListener('input', () => refresh(input.value))

  repo.fetchAll()
    .then(channels => {
      allChannels = channels
      refresh('')
    })
    .catch(() => {
      grid.textContent = 'Error cargando canales.'
    })

  return root
}
