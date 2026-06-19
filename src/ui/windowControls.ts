import { getCurrentWindow } from '@tauri-apps/api/window'

// Controles de ventana propios y temados (Windows/Linux, sin barra nativa).
export function createWindowControls(): HTMLElement {
  const win = getCurrentWindow()
  const bar = document.createElement('div')
  bar.className = 'window-controls'

  const button = (label: string, title: string, action: () => void, extra = '') => {
    const b = document.createElement('button')
    b.className = `window-control ${extra}`.trim()
    b.textContent = label
    b.title = title
    b.addEventListener('click', action)
    bar.appendChild(b)
  }

  button('—', 'Minimizar', () => win.minimize())
  button('☐', 'Maximizar', () => win.toggleMaximize())
  button('✕', 'Cerrar', () => win.close(), 'close')

  return bar
}
