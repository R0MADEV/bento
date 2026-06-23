import { invoke } from '@tauri-apps/api/core'
import { normalizeUrl } from '../../core/web/normalizeUrl'
import { icon } from '../../ui/icons'

let webPanelCounter = 0

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

  bar.append(input, goBtn)

  const content = document.createElement('div')
  content.className = 'web-content'

  root.append(bar, content)

  let currentUrl = ''
  let isVisible = true

  // window.screenLeft/Top gives the content area origin (below OS title bar),
  // already in CSS logical pixels — same unit as WebviewWindowBuilder::position().
  const getBounds = () => {
    const rect = content.getBoundingClientRect()
    return {
      x: window.screenLeft + rect.left,
      y: window.screenTop + rect.top,
      width: rect.width,
      height: rect.height,
    }
  }

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw)
    currentUrl = url
    input.value = url
    invoke('web_panel_navigate', { id: panelId, url, ...getBounds() }).catch(() => {})
  }

  const updateBounds = () => {
    if (!currentUrl) return
    invoke('web_panel_set_bounds', { id: panelId, ...getBounds() }).catch(() => {})
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(input.value) }
    e.stopPropagation()
  })
  goBtn.addEventListener('click', () => { if (input.value) navigate(input.value) })

  const resizeObserver = new ResizeObserver(updateBounds)
  resizeObserver.observe(content)

  // Sync visibility with IntersectionObserver (panel hidden by dockview tab switch)
  const intersectionObserver = new IntersectionObserver(entries => {
    const visible = entries[0]?.isIntersecting ?? true
    if (visible === isVisible) return
    isVisible = visible
    invoke('web_panel_set_visible', { id: panelId, visible }).catch(() => {})
  }, { threshold: 0 })
  intersectionObserver.observe(content)

  return {
    element: root,
    fit: () => { updateBounds() },
    focus: () => input.focus(),
    dispose: () => {
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      invoke('web_panel_close', { id: panelId }).catch(() => {})
    },
  }
}
