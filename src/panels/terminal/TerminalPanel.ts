import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { SearchAddon } from 'xterm-addon-search'
import { Unicode11Addon } from 'xterm-addon-unicode11'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getTheme } from '../../core/terminal/themes'
import { dimsChanged, type Dims } from '../../core/terminal/dims'
import { splitAtSyncBoundary } from '../../core/terminal/syncOutput'
import { getThemeName, onThemeChange } from './themePreference'
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
    cursorStyle: 'bar',
    fontSize: 13,
    // Prefiere Nerd Fonts (iconos de Powerlevel10k/Starship); si no, mono normal
    fontFamily: '"JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", "CaskaydiaCove Nerd Font", "Symbols Nerd Font", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Monaco, monospace',
    fontWeight: '400',
    fontWeightBold: '700',
    // Keep defaults (1.0 / 0): box-drawing and block chars must tile without
    // gaps, otherwise heavily-animated TUIs (catunes' bars/borders) shimmer.
    lineHeight: 1.0,
    letterSpacing: 0,
    allowProposedApi: true,
    // Opaque background: allowTransparency makes the renderer clear-to-transparent
    // and repaint each frame, which flickers on animated fullscreen TUIs.
    allowTransparency: false,
    scrollback: 10000,
    theme: getTheme(getThemeName()),
  })

  const unsubscribeTheme = onThemeChange(name => { term.options.theme = getTheme(name) })

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

  // Default DOM renderer (no WebGL/canvas): it updates cells incrementally and
  // never clears a whole canvas, so fullscreen redraws don't blank/flicker in
  // WKWebView. Fast enough for a single terminal.

  fitAddon.fit()

  // Barra de búsqueda (Ctrl/Cmd+F)
  const searchBar = createSearchBar(searchAddon)
  root.appendChild(searchBar.element)

  const id = `pty-${++ptyCounter}`
  const shell = navigator.platform.includes('Win') ? 'powershell.exe' : '/bin/bash'

  invoke('pty_spawn', { id, shell, rows: term.rows, cols: term.cols })
    .catch(err => term.writeln(`\r\n\x1b[31mError PTY: ${err}\x1b[0m`))

  // Respect DEC mode 2026 (Synchronized Output): catunes (Ink) brackets each
  // frame in ESC[?2026h..l so terminals show whole frames. xterm.js 5.3 ignores
  // 2026, so a half-frame paints the erased intermediate state → flicker. We
  // buffer and only write complete frames (see splitAtSyncBoundary).
  let pending = ''
  let safety: ReturnType<typeof setTimeout> | undefined
  listen<string>(`pty-output-${id}`, event => {
    pending += event.payload
    const { flush, keep } = splitAtSyncBoundary(pending)
    pending = keep
    if (flush) term.write(flush)
    if (safety) clearTimeout(safety)
    // Never hold an unterminated frame indefinitely (spec uses a ~150ms cap).
    safety = pending ? setTimeout(() => { term.write(pending); pending = '' }, 150) : undefined
  })

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

  // Only forward a resize to the PTY when the cell size changes: a repeated
  // SIGWINCH with the same size makes TUIs (Ink) flicker by fully repainting.
  let lastDims: Dims = { rows: 0, cols: 0 }
  const fit = () => {
    // requestAnimationFrame ensures the container already has its final size
    requestAnimationFrame(() => {
      fitAddon.fit()
      const dims: Dims = { rows: term.rows, cols: term.cols }
      if (!dimsChanged(lastDims, dims)) return
      lastDims = dims
      invoke('pty_resize', { id, ...dims }).catch(() => {})
    })
  }

  const observer = new ResizeObserver(fit)
  observer.observe(root)

  const dispose = () => {
    observer.disconnect()
    unsubscribeTheme()
    invoke('pty_kill', { id }).catch(() => {})
    // Guard term.dispose: if it throws and the exception reaches Dockview, it
    // breaks removePanel and the layout doesn't redistribute.
    try {
      term.dispose()
    } catch {
      // ignored
    }
  }

  return { element: root, fit, dispose }
}
