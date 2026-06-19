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

  const status = document.createElement('span')
  status.className = 'tv-status'

  toolbar.appendChild(input)
  toolbar.appendChild(status)

  const grid = document.createElement('div')
  grid.className = 'tv-grid'

  const player = new HLSPlayer()

  root.appendChild(toolbar)
  root.appendChild(grid)
  root.appendChild(player.element)

  let allChannels: Channel[] = []

  const onSelect = (ch: Channel) => {
    const hasStream = ch.streamUrl !== undefined
    status.textContent = hasStream ? `▶ ${ch.name}` : `⚠ ${ch.name} — sin stream`
    console.log(`[TV] canal: ${ch.name}, url: ${ch.streamUrl}`)
    player.play(ch)
  }

  const refresh = (query: string) =>
    renderGrid(grid, filterChannels(allChannels, query), onSelect)

  input.addEventListener('input', () => refresh(input.value))

  status.textContent = 'Cargando...'

  repo.fetchAll()
    .then(channels => {
      allChannels = channels.filter(c => c.streamUrl !== undefined)
      status.textContent = `${allChannels.length} canales`
      refresh('')
    })
    .catch(err => {
      console.error('[TV] Error:', err)
      status.textContent = `Error: ${err.message}`
    })

  return root
}
