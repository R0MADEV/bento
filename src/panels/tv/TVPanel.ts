import { t as i18nT } from '../../i18n'
import type { ChannelRepository } from '../../ports/ChannelRepository'
import type { FavoritesRepository } from '../../ports/FavoritesRepository'
import type { Channel, ChannelData } from '../../core/channel/Channel'
import { applyFilters } from '../../core/channel/channelFilters'
import { countryOptions, categoryOptions, type FilterOption } from '../../core/channel/filterOptions'
import { mergeChannelData } from '../../core/channel/mergeChannelData'
import { toggleFavorite, isFavorite } from '../../core/channel/favorites'
import { renderGrid } from './grid'
import { HLSPlayer } from './player'
import { icon } from '../../ui/helpers/icons'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { PanelInstance } from '../registry'

// repo = lightweight base (M3U); worldRepo = heavy source loaded on demand
export function createTVPanel(
  repo: ChannelRepository,
  favoritesRepo: FavoritesRepository,
  worldRepo?: ChannelRepository
): PanelInstance {
  const root = document.createElement('div')
  root.className = 'tv-panel'

  const toolbar = document.createElement('div')
  toolbar.className = 'tv-toolbar'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = i18nT('common.search2')
  input.className = 'tv-search'

  const countrySelect = document.createElement('select')
  countrySelect.className = 'tv-select'

  const categorySelect = document.createElement('select')
  categorySelect.className = 'tv-select'

  const status = document.createElement('span')
  status.className = 'tv-status'

  const worldButton = document.createElement('button')
  worldButton.className = 'tv-btn'
  worldButton.innerHTML = icon('globe')
  worldButton.title = i18nT('tv.loadChannelsFromAroundTheWorldHeavier')

  const favButton = document.createElement('button')
  favButton.className = 'tv-btn'
  favButton.innerHTML = icon('star')
  favButton.title = i18nT('tv.showFavoritesOnly')

  const fullscreenButton = document.createElement('button')
  fullscreenButton.className = 'tv-btn'
  fullscreenButton.innerHTML = icon('expand')
  fullscreenButton.title = i18nT('tv.fullscreen')

  const toggleButton = document.createElement('button')
  toggleButton.className = 'tv-btn'
  toggleButton.innerHTML = icon('panel')
  toggleButton.title = i18nT('tv.showHideChannelList')

  const pipButton = document.createElement('button')
  pipButton.className = 'tv-btn'
  pipButton.innerHTML = icon('pip')
  pipButton.title = 'Picture in Picture'

  toolbar.append(input, countrySelect, categorySelect, status)
  if (worldRepo) toolbar.append(worldButton)
  toolbar.append(favButton, pipButton, fullscreenButton, toggleButton)

  const main = document.createElement('div')
  main.className = 'tv-main'

  const stage = document.createElement('div')
  stage.className = 'tv-stage'

  const grid = document.createElement('div')
  grid.className = 'tv-grid'

  const player = new HLSPlayer()

  // Empty state: before a channel is chosen
  const emptyState = document.createElement('div')
  emptyState.className = 'tv-empty'
  emptyState.innerHTML = `${icon('tv')}<p>Elige un canal para empezar</p>`

  stage.append(player.element, emptyState)
  // toolbar + stage + grid are siblings of the grid: this lets the layout switch
  // from stacked (narrow) to left sidebar + player on the right (wide).
  main.append(toolbar, stage, grid)
  root.append(main)

  // Responsive layout based on the panel's REAL width (not the viewport: in
  // dockview the panel can take up any fraction). Container queries don't work
  // here because they would break the position:fixed of cinema mode.
  const syncWide = (w: number) => main.classList.toggle('wide', w >= 700)
  const resizeObserver = new ResizeObserver(entries => { for (const e of entries) syncWide(e.contentRect.width) })
  resizeObserver.observe(main)

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
    else status.textContent = i18nT('tv.unavailable', { channel: current })
  }

  const refresh = () => {
    let list = applyFilters(allChannels, {
      query: input.value,
      country: countrySelect.value,
      category: categorySelect.value,
    })
    if (onlyFavorites) list = list.filter(ch => isFavorite(favorites, ch.id))

    renderGrid(grid, list, {
      onSelect: ch => { current = ch.name; emptyState.classList.add('hidden'); player.play(ch) },
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
    fillSelect(countrySelect, i18nT('tv.country2'), countryOptions(next.channels, next.countries))
    fillSelect(categorySelect, i18nT('common.category'), categoryOptions(next.channels, next.categories))
    status.textContent = i18nT('tv.channelCount', { count: next.channels.length })
    refresh()
  }

  input.addEventListener('input', refresh)
  countrySelect.addEventListener('change', refresh)
  categorySelect.addEventListener('change', refresh)
  toggleButton.addEventListener('click', () => main.classList.toggle('list-hidden'))

  // Fullscreen: cinema mode (the stage covers the app) + real window fullscreen
  let cinema = false
  const setCinema = (on: boolean) => {
    cinema = on
    stage.classList.toggle('cinema', on)
    getCurrentWindow().setFullscreen(on).catch(() => {})
  }
  fullscreenButton.addEventListener('click', () => setCinema(!cinema))
  const onEscapeKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && cinema) setCinema(false) }
  window.addEventListener('keydown', onEscapeKey)
  favButton.addEventListener('click', () => {
    onlyFavorites = !onlyFavorites
    favButton.classList.toggle('active', onlyFavorites)
    refresh()
  })

  worldButton.addEventListener('click', async () => {
    if (!worldRepo) return
    worldButton.disabled = true
    worldButton.classList.add('loading')
    try {
      const world = await worldRepo.fetchAll()
      applyData(mergeChannelData([data, world]))
      worldButton.remove()
    } catch {
      worldButton.disabled = false
      worldButton.classList.remove('loading')
    }
  })

  const onEnterPip = () => pipButton.classList.add('active')
  const onLeavePip = () => pipButton.classList.remove('active')
  document.addEventListener('enterpictureinpicture', onEnterPip)
  document.addEventListener('leavepictureinpicture', onLeavePip)

  pipButton.addEventListener('click', async () => {
    try {
      await player.pip()
    } catch {
      const prev = pipButton.title
      pipButton.title = 'Reproduce un canal primero'
      pipButton.style.opacity = '0.4'
      setTimeout(() => { pipButton.title = prev; pipButton.style.opacity = '' }, 1500)
    }
  })

  status.textContent = i18nT('tv.loading')
  repo.fetchAll()
    .then(applyData)
    .catch(err => { status.textContent = i18nT('tv.errorMessage', { message: err.message }) })

  return {
    element: root,
    dispose: () => {
      player.dispose()
      resizeObserver.disconnect()
      window.removeEventListener('keydown', onEscapeKey)
      document.removeEventListener('enterpictureinpicture', onEnterPip)
      document.removeEventListener('leavepictureinpicture', onLeavePip)
    },
    onVisibilityChange: (visible: boolean) => {
      if (!visible && !player.isInPiP) player.pause()
      else if (visible) player.resume()
    },
  }
}
