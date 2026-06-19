import type { ChannelRepository } from '../../ports/ChannelRepository'
import type { FavoritesRepository } from '../../ports/FavoritesRepository'
import type { Channel } from '../../core/channel/Channel'
import { applyFilters } from '../../core/channel/channelFilters'
import { countryOptions, categoryOptions, type FilterOption } from '../../core/channel/filterOptions'
import { toggleFavorite, isFavorite } from '../../core/channel/favorites'
import { renderGrid } from './grid'
import { HLSPlayer } from './player'

export function createTVPanel(repo: ChannelRepository, favoritesRepo: FavoritesRepository): HTMLElement {
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

  const favButton = document.createElement('button')
  favButton.className = 'tv-btn'
  favButton.textContent = '★'
  favButton.title = 'Mostrar solo favoritos'

  const pipButton = document.createElement('button')
  pipButton.className = 'tv-btn'
  pipButton.textContent = '⧉'
  pipButton.title = 'Picture-in-Picture'

  const toggleButton = document.createElement('button')
  toggleButton.className = 'tv-btn'
  toggleButton.textContent = '☰'
  toggleButton.title = 'Mostrar/ocultar lista de canales'

  toolbar.append(input, countrySelect, categorySelect, status, favButton, pipButton, toggleButton)

  const main = document.createElement('div')
  main.className = 'tv-main'

  const stage = document.createElement('div')
  stage.className = 'tv-stage'

  const grid = document.createElement('div')
  grid.className = 'tv-grid'

  const player = new HLSPlayer()
  stage.appendChild(player.element)
  main.append(stage, grid)
  root.append(toolbar, main)

  let allChannels: Channel[] = []
  let favorites = favoritesRepo.load()
  let onlyFavorites = false

  const fillSelect = (select: HTMLSelectElement, placeholder: string, options: FilterOption[]) => {
    select.innerHTML = ''
    const all = document.createElement('option')
    all.value = ''
    all.textContent = placeholder
    select.appendChild(all)
    options.forEach(o => {
      const opt = document.createElement('option')
      opt.value = o.value
      opt.textContent = o.label
      select.appendChild(opt)
    })
  }

  let current = ''
  player.onStatus = s => {
    if (s === 'loading') status.textContent = `⏳ ${current}`
    else if (s === 'playing') status.textContent = `▶ ${current}`
    else status.textContent = `⚠ ${current} — no disponible`
  }

  const refresh = () => {
    let list = applyFilters(allChannels, {
      query: input.value,
      country: countrySelect.value,
      category: categorySelect.value,
    })
    if (onlyFavorites) list = list.filter(ch => isFavorite(favorites, ch.id))

    renderGrid(grid, list, {
      onSelect: ch => { current = ch.name; player.play(ch) },
      isFavorite: ch => isFavorite(favorites, ch.id),
      onToggleFavorite: ch => {
        favorites = toggleFavorite(favorites, ch.id)
        favoritesRepo.save(favorites)
        refresh()
      },
    })
  }

  input.addEventListener('input', refresh)
  countrySelect.addEventListener('change', refresh)
  categorySelect.addEventListener('change', refresh)
  pipButton.addEventListener('click', () => player.togglePiP().catch(() => {}))
  toggleButton.addEventListener('click', () => main.classList.toggle('list-hidden'))
  favButton.addEventListener('click', () => {
    onlyFavorites = !onlyFavorites
    favButton.classList.toggle('active', onlyFavorites)
    refresh()
  })

  status.textContent = 'Cargando...'

  repo.fetchAll()
    .then(({ channels, countries, categories }) => {
      allChannels = channels
      fillSelect(countrySelect, '🌍 País', countryOptions(channels, countries))
      fillSelect(categorySelect, 'Categoría', categoryOptions(channels, categories))
      status.textContent = `${channels.length} canales`
      refresh()
    })
    .catch(err => {
      status.textContent = `Error: ${err.message}`
    })

  return root
}
