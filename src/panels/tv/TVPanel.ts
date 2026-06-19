import type { ChannelRepository } from '../../ports/ChannelRepository'
import type { FavoritesRepository } from '../../ports/FavoritesRepository'
import type { Channel, ChannelData } from '../../core/channel/Channel'
import { applyFilters } from '../../core/channel/channelFilters'
import { countryOptions, categoryOptions, type FilterOption } from '../../core/channel/filterOptions'
import { mergeChannelData } from '../../core/channel/mergeChannelData'
import { toggleFavorite, isFavorite } from '../../core/channel/favorites'
import { renderGrid } from './grid'
import { HLSPlayer } from './player'

// repo = base ligera (M3U); worldRepo = fuente pesada cargada bajo demanda
export function createTVPanel(
  repo: ChannelRepository,
  favoritesRepo: FavoritesRepository,
  worldRepo?: ChannelRepository
): HTMLElement {
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

  const worldButton = document.createElement('button')
  worldButton.className = 'tv-btn'
  worldButton.textContent = '🌍 Mundial'
  worldButton.title = 'Cargar canales de todo el mundo (más pesado)'

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

  toolbar.append(input, countrySelect, categorySelect, status)
  if (worldRepo) toolbar.append(worldButton)
  toolbar.append(favButton, pipButton, toggleButton)

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

  let data: ChannelData = { channels: [], countries: [], categories: [] }
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

  const applyData = (next: ChannelData) => {
    data = next
    allChannels = next.channels
    fillSelect(countrySelect, '🌍 País', countryOptions(next.channels, next.countries))
    fillSelect(categorySelect, 'Categoría', categoryOptions(next.channels, next.categories))
    status.textContent = `${next.channels.length} canales`
    refresh()
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

  worldButton.addEventListener('click', async () => {
    if (!worldRepo) return
    worldButton.disabled = true
    worldButton.textContent = '⏳ Cargando...'
    try {
      const world = await worldRepo.fetchAll()
      applyData(mergeChannelData([data, world]))
      worldButton.remove()
    } catch {
      worldButton.disabled = false
      worldButton.textContent = '🌍 Reintentar'
    }
  })

  status.textContent = 'Cargando...'
  repo.fetchAll()
    .then(applyData)
    .catch(err => { status.textContent = `Error: ${err.message}` })

  return root
}
