import type { ChannelRepository } from '../../ports/ChannelRepository'
import type { Channel } from '../../core/channel/Channel'
import { applyFilters, availableCountries, availableCategories } from '../../core/channel/channelFilters'
import { renderGrid } from './grid'
import { HLSPlayer } from './player'

export function createTVPanel(repo: ChannelRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'tv-panel'

  const toolbar = document.createElement('div')
  toolbar.className = 'tv-toolbar'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Buscar...'
  input.className = 'tv-search'

  const countrySelect = document.createElement('select')
  countrySelect.className = 'tv-select'

  const categorySelect = document.createElement('select')
  categorySelect.className = 'tv-select'

  const status = document.createElement('span')
  status.className = 'tv-status'

  const pipButton = document.createElement('button')
  pipButton.className = 'tv-pip'
  pipButton.textContent = '⧉ PiP'
  pipButton.title = 'Picture-in-Picture (flota sobre otras apps)'

  toolbar.append(input, countrySelect, categorySelect, status, pipButton)

  const grid = document.createElement('div')
  grid.className = 'tv-grid'

  const player = new HLSPlayer()

  root.append(toolbar, grid, player.element)

  let allChannels: Channel[] = []

  const fillSelect = (select: HTMLSelectElement, label: string, options: string[]) => {
    select.innerHTML = ''
    const all = document.createElement('option')
    all.value = ''
    all.textContent = label
    select.appendChild(all)
    options.forEach(opt => {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      select.appendChild(o)
    })
  }

  let current = ''
  player.onStatus = s => {
    if (s === 'loading') status.textContent = `⏳ ${current}`
    else if (s === 'playing') status.textContent = `▶ ${current}`
    else status.textContent = `⚠ ${current} — stream no disponible`
  }

  const onSelect = (ch: Channel) => {
    current = ch.name
    player.play(ch)
  }

  const refresh = () => {
    const filtered = applyFilters(allChannels, {
      query: input.value,
      country: countrySelect.value,
      category: categorySelect.value,
    })
    status.textContent = `${filtered.length} canales`
    renderGrid(grid, filtered, onSelect)
  }

  input.addEventListener('input', refresh)
  countrySelect.addEventListener('change', refresh)
  categorySelect.addEventListener('change', refresh)
  pipButton.addEventListener('click', () => player.togglePiP().catch(() => {}))

  status.textContent = 'Cargando...'

  repo.fetchAll()
    .then(channels => {
      allChannels = channels
      fillSelect(countrySelect, 'Todos los países', availableCountries(channels))
      fillSelect(categorySelect, 'Todas las categorías', availableCategories(channels))
      refresh()
    })
    .catch(err => {
      status.textContent = `Error: ${err.message}`
    })

  return root
}
