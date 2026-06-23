import { invoke } from '@tauri-apps/api/core'
import { normalizeUrl } from '../../core/web/normalizeUrl'
import { isWebviewVisible } from '../../core/web/webviewVisibility'
import { resolveUserAgent, hostOf, getUaMode, setUaMode, type UaMode } from '../../core/web/userAgent'
import { icon } from '../../ui/icons'

let webPanelCounter = 0

const UA_KEY = 'bento.web.ua'
const loadUaPrefs = (): Record<string, UaMode> => {
  try { return JSON.parse(localStorage.getItem(UA_KEY) ?? '{}') } catch { return {} }
}
const saveUaPrefs = (prefs: Record<string, UaMode>): void =>
  localStorage.setItem(UA_KEY, JSON.stringify(prefs))

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

  bar.append(input, uaSelect, goBtn)

  const content = document.createElement('div')
  content.className = 'web-content'

  root.append(bar, content)

  let currentUrl = ''
  let isVisible = true

  // Viewport-relative rect — add_child positions the webview window-relatively, no conversion needed
  const getRect = () => {
    const r = content.getBoundingClientRect()
    return { rectX: r.left, rectY: r.top, width: r.width, height: r.height }
  }

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw)
    currentUrl = url
    input.value = url
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

  const updateBounds = () => {
    if (!currentUrl) return
    invoke('web_panel_set_bounds', { id: panelId, ...getRect() }).catch(() => {})
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(input.value) }
    e.stopPropagation()
  })
  goBtn.addEventListener('click', () => { if (input.value) navigate(input.value) })

  // The native webview floats above the DOM, immune to CSS — it must be hidden
  // explicitly when the panel isn't visible. checkVisibility is computed from the
  // placeholder: intersection (display:none / viewport) + inherited visibility.
  let intersecting = true
  let suppressed = false
  const reevaluate = () => {
    if (!currentUrl) return
    const style = getComputedStyle(content)
    const visible = isWebviewVisible({
      intersecting,
      visibility: style.visibility,
      display: style.display,
      opacity: style.opacity,
      suppressed,
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
      invoke('web_panel_close', { id: panelId }).catch(() => {})
    },
  }
}
