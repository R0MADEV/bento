import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { SearchAddon } from 'xterm-addon-search'
import { WebglAddon } from 'xterm-addon-webgl'
import { Unicode11Addon } from 'xterm-addon-unicode11'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getTheme, DEFAULT_THEME } from '../../core/terminal/themes'
import { createSearchBar } from './searchBar'
import 'xterm/css/xterm.css'

let ptyCounter = 0

export interface TerminalPanelHandle {
  element: HTMLElement
  fit: () => void
  dispose: () => void
}

export function createTerminalPanel(): TerminalPanelHandle {
  const root = document.createElement('div')
  root.className = 'terminal-panel'

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Cascadia Code", "Fira Code", monospace',
    allowProposedApi: true,
    scrollback: 10000,
    theme: getTheme(DEFAULT_THEME),
  })

  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  // Links clicables → abrir en el navegador del SO
  term.loadAddon(new WebLinksAddon((_event, uri) => {
    openUrl(uri).catch(() => {})
  }))

  term.open(root)

  // WebGL acelera el render; si falla (sin GPU en Docker) seguimos con canvas
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    // canvas fallback automático
  }

  fitAddon.fit()

  // Barra de búsqueda (Ctrl/Cmd+F)
  const searchBar = createSearchBar(searchAddon)
  root.appendChild(searchBar.element)

  const id = `pty-${++ptyCounter}`
  const shell = navigator.platform.includes('Win') ? 'powershell.exe' : '/bin/bash'

  invoke('pty_spawn', { id, shell, rows: term.rows, cols: term.cols })
    .catch(err => term.writeln(`\r\n\x1b[31mError PTY: ${err}\x1b[0m`))

  listen<string>(`pty-output-${id}`, event => term.write(event.payload))

  term.onData(data => {
    invoke('pty_write', { id, data }).catch(() => {})
  })

  // Copiar/pegar
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true
    const mod = e.metaKey || e.ctrlKey

    if (mod && e.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {})
      return false
    }
    if (mod && e.key === 'v') {
      navigator.clipboard.readText().then(text => {
        invoke('pty_write', { id, data: text }).catch(() => {})
      }).catch(() => {})
      return false
    }
    if (mod && e.key === 'f') {
      searchBar.toggle()
      return false
    }
    return true
  })

  root.addEventListener('click', () => term.focus())
  setTimeout(() => term.focus(), 100)

  const fit = () => {
    // requestAnimationFrame asegura que el contenedor ya tiene su tamaño final
    requestAnimationFrame(() => {
      fitAddon.fit()
      invoke('pty_resize', { id, rows: term.rows, cols: term.cols }).catch(() => {})
    })
  }

  const observer = new ResizeObserver(fit)
  observer.observe(root)

  const dispose = () => {
    observer.disconnect()
    invoke('pty_kill', { id }).catch(() => {})
    term.dispose()
  }

  return { element: root, fit, dispose }
}
