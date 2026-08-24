import { getCurrentWindow } from '@tauri-apps/api/window'
import { icon } from './helpers/icons'

// Custom, themed window controls (Windows/Linux, no native title bar).
export function createWindowControls(): HTMLElement {
  const win = getCurrentWindow()
  const bar = document.createElement('div')
  bar.className = 'window-controls'

  const button = (svg: string, title: string, action: () => void, extra = '') => {
    const b = document.createElement('button')
    b.className = `window-control ${extra}`.trim()
    b.innerHTML = svg
    b.title = title
    b.addEventListener('click', action)
    bar.appendChild(b)
  }

  button(icon('minus'), 'Minimizar', () => win.minimize())
  button(icon('square'), 'Maximizar', () => win.toggleMaximize())
  button(icon('x'), 'Cerrar', () => win.close(), 'close')

  return bar
}
