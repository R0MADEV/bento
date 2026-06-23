import { invoke } from '@tauri-apps/api/core'
import { normalizeUrl, resolveTargetUrl } from '../../core/web/normalizeUrl'
import { isWebviewVisible } from '../../core/web/webviewVisibility'
import { resolveUserAgent, hostOf, getUaMode, setUaMode, type UaMode } from '../../core/web/userAgent'
import { addHistory, searchHistory, type HistoryEntry } from '../../core/web/history'
import { addBookmark, removeBookmark, isBookmarked, groupBookmarks, type Bookmark } from '../../core/web/bookmarks'
import { icon } from '../../ui/icons'

let webPanelCounter = 0

const readJson = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
}

const UA_KEY = 'bento.web.ua'
const loadUaPrefs = (): Record<string, UaMode> => readJson(UA_KEY, {})
const saveUaPrefs = (prefs: Record<string, UaMode>): void =>
  localStorage.setItem(UA_KEY, JSON.stringify(prefs))

const HISTORY_KEY = 'bento.web.history'
const loadHistory = (): HistoryEntry[] => readJson(HISTORY_KEY, [])
const saveHistory = (h: HistoryEntry[]): void => localStorage.setItem(HISTORY_KEY, JSON.stringify(h))

const BOOKMARKS_KEY = 'bento.web.bookmarks'
const loadBookmarks = (): Bookmark[] => readJson(BOOKMARKS_KEY, [])
const saveBookmarks = (b: Bookmark[]): void => localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(b))

export function createWebPanel() {
  const panelId = `web-panel-${++webPanelCounter}`

  const root = document.createElement('div')
  root.className = 'web-panel'

  const bar = document.createElement('div')
  bar.className = 'web-bar'

  const input = document.createElement('input')
  input.className = 'web-url-input'
  input.type = 'url'
  input.placeholder = 'https://…'
  input.spellcheck = false

  const goBtn = document.createElement('button')
  goBtn.className = 'web-bar-btn'
  goBtn.title = 'Navegar'
  goBtn.innerHTML = icon('refresh')

  // Per-site engine: Chrome UA (WhatsApp etc.) vs native Safari (Google login).
  const uaSelect = document.createElement('select')
  uaSelect.className = 'web-ua-select'
  uaSelect.title = 'Motor para este sitio'
  ;([['chrome', 'Chrome'], ['default', 'Safari']] as const).forEach(([val, label]) => {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    uaSelect.appendChild(opt)
  })

  const starBtn = document.createElement('button')
  starBtn.className = 'web-bar-btn web-star'
  starBtn.title = 'Guardar en favoritos'
  starBtn.innerHTML = icon('star')

  const bmBtn = document.createElement('button')
  bmBtn.className = 'web-bar-btn'
  bmBtn.title = 'Favoritos'
  bmBtn.innerHTML = icon('list')

  bar.append(input, uaSelect, starBtn, bmBtn, goBtn)

  // Autocomplete from history, anchored under the URL input.
  const suggest = document.createElement('div')
  suggest.className = 'web-suggest hidden'
  bar.appendChild(suggest)

  // Bookmarks dropdown — shown above the native webview (which we hide while open).
  const menu = document.createElement('div')
  menu.className = 'web-bookmarks hidden'
  bar.appendChild(menu)

  // Inline "save bookmark" form — prompt() is unreliable in the Tauri webview.
  const savePop = document.createElement('div')
  savePop.className = 'web-save hidden'
  const groupInput = document.createElement('input')
  groupInput.className = 'web-save-input'
  groupInput.placeholder = 'Proyecto / grupo'
  const saveOk = document.createElement('button')
  saveOk.className = 'web-bar-btn'
  saveOk.innerHTML = icon('star')
  saveOk.title = 'Guardar'
  savePop.append(groupInput, saveOk)
  bar.appendChild(savePop)

  const content = document.createElement('div')
  content.className = 'web-content'

  // Quick-launch grid of bookmarks, shown while no page is loaded.
  const empty = document.createElement('div')
  empty.className = 'web-empty'

  content.appendChild(empty)
  root.append(bar, content)

  let currentUrl = ''
  let isVisible = true
  let lastGroup = 'General'

  // Viewport-relative rect — add_child positions the webview window-relatively, no conversion needed
  const getRect = () => {
    const r = content.getBoundingClientRect()
    return { rectX: r.left, rectY: r.top, width: r.width, height: r.height }
  }

  const refreshStar = () => starBtn.classList.toggle('active', !!currentUrl && isBookmarked(loadBookmarks(), currentUrl))

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw)
    currentUrl = url
    input.value = url
    suggest.classList.add('hidden')
    empty.classList.add('hidden')
    saveHistory(addHistory(loadHistory(), url, Date.now()))
    refreshStar()
    const mode = getUaMode(loadUaPrefs(), hostOf(url))
    uaSelect.value = mode
    invoke('web_panel_navigate', { id: panelId, url, ...getRect(), userAgent: resolveUserAgent(mode) }).catch(() => {})
  }

  // Changing the engine saves it for this host and reloads (Rust recreates the webview).
  uaSelect.addEventListener('change', () => {
    if (!currentUrl) return
    saveUaPrefs(setUaMode(loadUaPrefs(), hostOf(currentUrl), uaSelect.value as UaMode))
    navigate(currentUrl)
  })

  const targetUrl = (): string => resolveTargetUrl(currentUrl, input.value)

  const closeOverlays = (): void => {
    savePop.classList.add('hidden')
    menu.classList.add('hidden')
    menuOpen = false
    reevaluate()
  }

  starBtn.addEventListener('click', e => {
    e.stopPropagation()
    const url = targetUrl()
    if (!url) return
    const bookmarks = loadBookmarks()
    const existing = bookmarks.find(b => b.url === url)
    if (existing) {
      saveBookmarks(removeBookmark(bookmarks, existing.id))
      refreshStar()
      renderEmpty()
      return
    }
    // Open the inline form above the webview to ask for the group.
    menu.classList.add('hidden')
    savePop.classList.remove('hidden')
    menuOpen = true
    reevaluate()
    groupInput.value = lastGroup
    groupInput.focus()
    groupInput.select()
  })

  const confirmSave = (): void => {
    const url = targetUrl()
    const group = groupInput.value.trim() || 'General'
    if (url) {
      saveBookmarks(addBookmark(loadBookmarks(), { id: Date.now().toString(36), url, title: hostOf(url), group }))
      lastGroup = group
    }
    closeOverlays()
    refreshStar()
    renderEmpty()
  }
  saveOk.addEventListener('click', confirmSave)
  groupInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSave()
    if (e.key === 'Escape') closeOverlays()
    e.stopPropagation()
  })

  input.addEventListener('input', () => {
    const matches = searchHistory(loadHistory(), input.value)
    if (!matches.length) { suggest.classList.add('hidden'); return }
    suggest.innerHTML = ''
    matches.forEach(m => {
      const item = document.createElement('button')
      item.className = 'web-suggest-item'
      item.textContent = m.url
      item.addEventListener('click', () => navigate(m.url))
      suggest.appendChild(item)
    })
    suggest.classList.remove('hidden')
  })
  input.addEventListener('blur', () => setTimeout(() => suggest.classList.add('hidden'), 150))

  const renderGroups = (container: HTMLElement, onPick: (url: string) => void): void => {
    container.innerHTML = ''
    const groups = groupBookmarks(loadBookmarks())
    if (!groups.length) {
      container.innerHTML = '<div class="web-empty-hint">Escribe una URL, o guarda favoritos con ★ para tenerlos aquí</div>'
      return
    }
    groups.forEach(g => {
      const section = document.createElement('div')
      section.className = 'web-empty-group'
      const title = document.createElement('div')
      title.className = 'web-empty-group-title'
      title.textContent = g.group
      const grid = document.createElement('div')
      grid.className = 'web-empty-grid'
      g.items.forEach(b => {
        const tile = document.createElement('button')
        tile.className = 'web-empty-tile'
        tile.textContent = b.title
        tile.title = b.url
        tile.addEventListener('click', () => onPick(b.url))
        grid.appendChild(tile)
      })
      section.append(title, grid)
      container.appendChild(section)
    })
  }
  const renderEmpty = () => renderGroups(empty, navigate)
  renderEmpty()

  bmBtn.addEventListener('click', e => {
    e.stopPropagation()
    if (!menu.classList.contains('hidden')) { closeOverlays(); return }
    savePop.classList.add('hidden')
    renderGroups(menu, url => { closeOverlays(); navigate(url) })
    menu.classList.remove('hidden')
    menuOpen = true
    reevaluate()
  })
  const onDocClick = (e: MouseEvent): void => {
    if (!menuOpen) return
    const t = e.target as Node
    const insideOverlay = menu.contains(t) || savePop.contains(t) || bmBtn.contains(t) || starBtn.contains(t)
    if (!insideOverlay) closeOverlays()
  }
  window.addEventListener('click', onDocClick)

  const updateBounds = () => {
    if (!currentUrl) return
    invoke('web_panel_set_bounds', { id: panelId, ...getRect() }).catch(() => {})
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(input.value) }
    if (e.key === 'Escape') suggest.classList.add('hidden')
    e.stopPropagation()
  })
  goBtn.addEventListener('click', () => { if (input.value) navigate(input.value) })

  // The native webview floats above the DOM, immune to CSS — it must be hidden
  // explicitly when the panel isn't visible. checkVisibility is computed from the
  // placeholder: intersection (display:none / viewport) + inherited visibility.
  let intersecting = true
  let suppressed = false
  let menuOpen = false
  const reevaluate = () => {
    if (!currentUrl) return
    const style = getComputedStyle(content)
    const visible = isWebviewVisible({
      intersecting,
      visibility: style.visibility,
      display: style.display,
      opacity: style.opacity,
      suppressed: suppressed || menuOpen,
    })
    if (visible === isVisible) return
    isVisible = visible
    invoke('web_panel_set_visible', { id: panelId, visible }).catch(() => {})
  }

  // DOM overlays (session popover, menus) must paint above the native webview;
  // they dispatch this so we hide the webview while they're shown.
  const onOverlay = (e: Event) => {
    suppressed = (e as CustomEvent<boolean>).detail
    reevaluate()
  }
  window.addEventListener('bento:web-overlay', onOverlay)

  const resizeObserver = new ResizeObserver(updateBounds)
  resizeObserver.observe(content)

  // display:none up the tree (dockview tab switch) flips intersection.
  const intersectionObserver = new IntersectionObserver(entries => {
    intersecting = entries[0]?.isIntersecting ?? true
    observeSession()
    reevaluate()
  }, { threshold: 0 })
  intersectionObserver.observe(content)

  // A hidden session sets visibility:hidden on the .session-instance ancestor,
  // which keeps the box (so intersection stays true) — watch its class to catch it.
  let sessionObserver: MutationObserver | undefined
  function observeSession() {
    if (sessionObserver) return
    const session = content.closest('.session-instance')
    if (!session) return
    sessionObserver = new MutationObserver(reevaluate)
    sessionObserver.observe(session, { attributes: true, attributeFilter: ['class'] })
  }

  return {
    element: root,
    fit: () => updateBounds(),
    focus: () => input.focus(),
    dispose: () => {
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      sessionObserver?.disconnect()
      window.removeEventListener('bento:web-overlay', onOverlay)
      window.removeEventListener('click', onDocClick)
      invoke('web_panel_close', { id: panelId }).catch(() => {})
    },
  }
}
