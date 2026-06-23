import { normalizeUrl } from '../../core/web/normalizeUrl'
import { icon } from '../../ui/icons'

export function createWebPanel() {
  const root = document.createElement('div')
  root.className = 'web-panel'

  const bar = document.createElement('div')
  bar.className = 'web-bar'

  const input = document.createElement('input')
  input.className = 'web-url-input'
  input.type = 'url'
  input.placeholder = 'https://…'
  input.spellcheck = false

  const reloadBtn = document.createElement('button')
  reloadBtn.className = 'web-bar-btn'
  reloadBtn.title = 'Recargar'
  reloadBtn.innerHTML = icon('refresh')

  bar.append(input, reloadBtn)

  const frame = document.createElement('iframe')
  frame.className = 'web-frame'
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('allow', 'autoplay; fullscreen')

  root.append(bar, frame)

  let currentUrl = ''

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw)
    currentUrl = url
    input.value = url
    frame.src = url
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(input.value) }
    e.stopPropagation()
  })

  reloadBtn.addEventListener('click', () => { if (currentUrl) frame.src = currentUrl })

  return {
    element: root,
    fit: () => {},
    focus: () => input.focus(),
    dispose: () => { frame.src = 'about:blank' },
  }
}
