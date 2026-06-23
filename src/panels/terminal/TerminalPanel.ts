import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { SearchAddon } from 'xterm-addon-search'
import { Unicode11Addon } from 'xterm-addon-unicode11'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getTheme, themeNames, themeLabels } from '../../core/terminal/themes'
import { mix, isDark } from '../../core/terminal/color'
import { dimsChanged, type Dims } from '../../core/terminal/dims'
import { splitAtSyncBoundary } from '../../core/terminal/syncOutput'
import { getThemeName, onThemeChange } from './themePreference'
import { nextTheme } from '../../core/terminal/nextTheme'
import { loadProfiles, addProfile, removeProfile } from '../../core/terminal/profiles'
import { createActivityTracker } from '../../core/terminal/activityTracker'
import { parseOsc7Path, toDisplayPath } from '../../core/terminal/osc7'
import { createSearchBar } from './searchBar'
import { icon } from '../../ui/icons'
import type { PanelApi } from '../registry'
import 'xterm/css/xterm.css'

const HISTORY_KEY = (id: string) => `bento.terminal.history.${id}`
const CWD_KEY = (id: string) => `bento.terminal.cwd.${id}`
const HISTORY_LIMIT = 80_000

let ptyCounter = 0

function showCommandDoneToast(termRoot: HTMLElement): void {
  const existing = termRoot.querySelector('.term-toast')
  if (existing) return
  const toast = document.createElement('div')
  toast.className = 'term-toast'
  toast.textContent = '✓ Comando terminado'
  termRoot.appendChild(toast)
  setTimeout(() => toast.remove(), 3000)
}

export interface TerminalPanelHandle {
  element: HTMLElement
  fit: () => void
  focus: () => void
  dispose: () => void
  onTitleChange: (cb: (title: string) => void) => () => void
  onReady: (api: PanelApi) => void
  getCwd: () => string | undefined
}

const DEFAULT_FONT_FAMILY = '"JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", "CaskaydiaCove Nerd Font", "Symbols Nerd Font", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Monaco, monospace'

export function createTerminalPanel(panelId = '', projectPath = ''): TerminalPanelHandle {
  const root = document.createElement('div')
  root.className = 'terminal-panel'

  let localFontFamily = DEFAULT_FONT_FAMILY

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily: localFontFamily,
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

  let localTheme = getThemeName()
  let followGlobal = true

  let titleCallback: ((title: string) => void) | undefined
  const tracker = createActivityTracker(t => titleCallback?.(t))
  // focusin bubbles from xterm's internal textarea — public API has no onFocus
  const onRootFocus = () => tracker.onFocus()
  root.addEventListener('focusin', onRootFocus)

  const applyLocalTheme = (name: string) => {
    const t = getTheme(name)
    term.options.theme = t

    // xterm DOM renderer: actualizar el viewport directamente (no espera actividad)
    const viewport = root.querySelector<HTMLElement>('.xterm-viewport')
    if (viewport) viewport.style.backgroundColor = t.background
    root.style.backgroundColor = t.background
    term.refresh(0, term.rows - 1)

    // La barra de tabs del grupo usa --surface (derivada del tema global).
    // Al cambiar el tema local hay que sobreescribirla en el .dv-groupview
    // para que la cabecera refleje el color del nuevo tema de esta terminal.
    const groupView = root.closest<HTMLElement>('.dv-groupview')
    if (groupView) {
      const shade = isDark(t.background) ? '#ffffff' : '#000000'
      groupView.style.setProperty('--surface', mix(t.background, shade, 0.05))
    }
  }

  const unsubscribeTheme = onThemeChange(name => {
    if (followGlobal) { localTheme = name; applyLocalTheme(name) }
  })

  const cycleLocalTheme = () => {
    followGlobal = false
    localTheme = nextTheme(localTheme, themeNames)
    applyLocalTheme(localTheme)
  }

  const applyCustomBackground = (bg: string) => {
    followGlobal = false
    const base = getTheme(localTheme)
    const custom = { ...base, background: bg, cursorAccent: bg }
    term.options.theme = custom
    const viewport = root.querySelector<HTMLElement>('.xterm-viewport')
    if (viewport) viewport.style.backgroundColor = bg
    root.style.backgroundColor = bg
    term.refresh(0, term.rows - 1)
    const groupView = root.closest<HTMLElement>('.dv-groupview')
    if (groupView) {
      const shade = isDark(bg) ? '#ffffff' : '#000000'
      groupView.style.setProperty('--surface', mix(bg, shade, 0.05))
    }
  }

  const popover = document.createElement('div')
  popover.className = 'term-theme-popover hidden'

  const swatches = document.createElement('div')
  swatches.className = 'term-theme-swatches'
  themeNames.forEach(name => {
    const t = getTheme(name)
    const swatch = document.createElement('button')
    swatch.className = 'term-theme-swatch'
    swatch.title = themeLabels[name] ?? name
    swatch.style.background = t.background
    swatch.style.borderColor = t.blue
    swatch.addEventListener('click', () => {
      followGlobal = false
      localTheme = name
      applyLocalTheme(name)
      popover.classList.add('hidden')
    })
    swatches.appendChild(swatch)
  })

  const colorRow = document.createElement('label')
  colorRow.className = 'term-theme-color-row'
  colorRow.textContent = 'Color personalizado'
  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  colorInput.value = getTheme(localTheme).background
  colorInput.addEventListener('input', () => applyCustomBackground(colorInput.value))
  colorRow.appendChild(colorInput)

  const isWin = navigator.platform.includes('Win')
  const shellOptions = isWin
    ? [['auto', 'Auto (SHELL)'], ['powershell.exe', 'PowerShell'], ['cmd.exe', 'CMD']]
    : [['auto', 'Auto (SHELL)'], ['/bin/zsh', 'zsh'], ['/bin/bash', 'bash'], ['fish', 'fish'], ['/bin/sh', 'sh']]

  const shellRow = document.createElement('div')
  shellRow.className = 'term-theme-color-row'
  const shellLabel = document.createElement('span')
  shellLabel.textContent = 'Shell'
  const shellSelect = document.createElement('select')
  shellSelect.className = 'term-shell-select'
  shellOptions.forEach(([val, label]) => {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    shellSelect.appendChild(opt)
  })
  shellRow.append(shellLabel, shellSelect)

  const fontRow = document.createElement('div')
  fontRow.className = 'term-theme-color-row'
  const fontLabel = document.createElement('span')
  fontLabel.textContent = 'Fuente'
  const fontInput = document.createElement('input')
  fontInput.className = 'term-font-input'
  fontInput.type = 'text'
  fontInput.placeholder = 'monospace'
  fontInput.addEventListener('change', () => {
    localFontFamily = fontInput.value.trim() || DEFAULT_FONT_FAMILY
    term.options.fontFamily = localFontFamily
    fit()
  })
  fontRow.append(fontLabel, fontInput)

  popover.append(swatches, colorRow, shellRow, fontRow)
  popover.addEventListener('click', e => e.stopPropagation())
  root.appendChild(popover)

  const themeBtn = document.createElement('button')
  themeBtn.className = 'term-theme-btn'
  themeBtn.title = 'Cambiar tema de esta terminal'
  themeBtn.innerHTML = icon('palette')
  themeBtn.addEventListener('click', e => {
    e.stopPropagation()
    popover.classList.toggle('hidden')
  })
  root.appendChild(themeBtn)

  root.addEventListener('click', () => popover.classList.add('hidden'))

  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  term.loadAddon(new WebLinksAddon((_event, uri) => {
    openUrl(uri).catch(() => {})
  }))

  term.open(root)

  fitAddon.fit()

  const savedHistory = panelId ? localStorage.getItem(HISTORY_KEY(panelId)) : null
  if (savedHistory) {
    term.write(savedHistory)
    term.write('\r\n\x1b[2m— historial restaurado —\x1b[0m\r\n')
  }

  const searchBar = createSearchBar(searchAddon)
  root.appendChild(searchBar.element)

  const id = `pty-${++ptyCounter}`

  let historyBuffer = ''

  // Restore the directory the terminal was in last session, so the (restored)
  // prompt matches reality and `lexis ask` / commands run in the right project.
  // Saved cwd (restored terminal) wins; else the session's project folder.
  let lastCwd = (panelId && localStorage.getItem(CWD_KEY(panelId))) || projectPath || ''

  const spawnShell = (shellPath: string) => {
    const resolved = shellPath === 'auto' ? (isWin ? 'powershell.exe' : '/bin/sh') : shellPath
    invoke('pty_spawn', { id, shell: resolved, rows: term.rows, cols: term.cols, cwd: lastCwd || null })
      .catch(err => term.writeln(`\r\n\x1b[31mError PTY: ${err}\x1b[0m`))
  }

  spawnShell('auto')

  shellSelect.addEventListener('change', () => {
    invoke('pty_kill', { id }).catch(() => {})
    term.reset()
    spawnShell(shellSelect.value)
    popover.classList.add('hidden')
  })

  // OSC 133;C = command start, 133;D = command end (shell integration)
  let commandRunning = false
  term.parser.registerOscHandler(133, data => {
    if (data.startsWith('C')) commandRunning = true
    const isCommandEnd = commandRunning && data.startsWith('D')
    if (isCommandEnd) {
      commandRunning = false
      const groupView = root.closest<HTMLElement>('.dv-groupview')
      const isVisible = groupView?.classList.contains('dv-active-group') ?? false
      if (!isVisible) showCommandDoneToast(root)
    }
    return true
  })

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
    if (flush) {
      term.write(flush)
      historyBuffer += flush
      if (historyBuffer.length > HISTORY_LIMIT) historyBuffer = historyBuffer.slice(-HISTORY_LIMIT)
      tracker.onOutput(root.contains(document.activeElement))
    }
    if (safety) clearTimeout(safety)
    // Never hold an unterminated frame indefinitely (spec uses a ~150ms cap).
    safety = pending ? setTimeout(() => { term.write(pending); pending = '' }, 150) : undefined
  })

  term.onData(data => {
    invoke('pty_write', { id, data }).catch(() => {})
  })

  const BASE_FONT_SIZE = 13
  const MIN_FONT_SIZE = 8
  const MAX_FONT_SIZE = 32

  const setFontSize = (size: number) => {
    term.options.fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
    fit()
  }

  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true
    const mod = e.metaKey || e.ctrlKey

    // Ctrl+Tab reaches xterm before window — re-dispatch so the workspace can cycle panels.
    // stopPropagation prevents the native keydown from also reaching onCyclePanelKeydown.
    if (e.ctrlKey && e.key === 'Tab') {
      e.stopPropagation()
      window.dispatchEvent(new CustomEvent('bento:cycle-panel', { detail: { reverse: e.shiftKey } }))
      return false
    }

    const isCopy = mod && e.key === 'c' && term.hasSelection()
    if (isCopy) {
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
    if (mod && e.key === 'j') {
      cycleLocalTheme()
      return false
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      setFontSize((term.options.fontSize ?? BASE_FONT_SIZE) + 1)
      return false
    }
    if (mod && e.key === '-') {
      setFontSize((term.options.fontSize ?? BASE_FONT_SIZE) - 1)
      return false
    }
    if (mod && e.key === '0') {
      setFontSize(BASE_FONT_SIZE)
      return false
    }
    if (mod && e.key === 'k') {
      term.clear()
      return false
    }
    return true
  })

  // capture:true prevents xterm from scrolling instead of zooming
  root.addEventListener('wheel', e => {
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    const delta = e.deltaY < 0 ? 1 : -1
    setFontSize((term.options.fontSize ?? BASE_FONT_SIZE) + delta)
  }, { passive: false, capture: true })

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
    if (panelId && historyBuffer) {
      try { localStorage.setItem(HISTORY_KEY(panelId), historyBuffer.slice(-HISTORY_LIMIT)) } catch { /* storage lleno */ }
    }
    if (panelId && lastCwd) {
      try { localStorage.setItem(CWD_KEY(panelId), lastCwd) } catch { /* storage lleno */ }
    }
    observer.disconnect()
    unsubscribeTheme()
    root.removeEventListener('focusin', onRootFocus)
    invoke('pty_kill', { id }).catch(() => {})
    try { term.dispose() } catch { /* ignorar */ }
  }

  const onTitleChange = (cb: (title: string) => void): (() => void) => {
    titleCallback = cb
    const d1 = term.onTitleChange(title => { if (title) tracker.setBase(title) })

    const d2 = term.parser.registerOscHandler(7, data => {
      const path = parseOsc7Path(data)
      if (path) {
        lastCwd = path
        tracker.setBase(toDisplayPath(path))
      }
      return true
    })

    return () => { titleCallback = undefined; d1.dispose(); d2.dispose() }
  }

  const maxBtn = document.createElement('button')
  maxBtn.className = 'term-theme-btn term-max-btn'
  maxBtn.title = 'Maximizar / restaurar'
  maxBtn.innerHTML = icon('expand')

  const onReady = (panelApi: PanelApi) => {
    maxBtn.addEventListener('click', () => {
      if (panelApi.isMaximized()) panelApi.exitMaximized()
      else panelApi.maximize()
    })

    const profilesSection = document.createElement('div')
    profilesSection.className = 'term-profiles-section'

    const renderProfiles = () => {
      profilesSection.innerHTML = ''
      const profiles = loadProfiles()

      if (profiles.length) {
        const list = document.createElement('div')
        list.className = 'term-profile-list'
        profiles.forEach(p => {
          const row = document.createElement('div')
          row.className = 'term-profile-row'
          const nameBtn = document.createElement('button')
          nameBtn.className = 'term-profile-name'
          nameBtn.textContent = p.name
          nameBtn.title = `Shell: ${p.shell} · Tema: ${p.theme} · ${p.fontSize}px${p.fontFamily ? ` · ${p.fontFamily}` : ''}`
          nameBtn.addEventListener('click', () => {
            followGlobal = false
            localTheme = p.theme
            applyLocalTheme(p.theme)
            setFontSize(p.fontSize)
            if (p.fontFamily) {
              localFontFamily = p.fontFamily
              fontInput.value = p.fontFamily
              term.options.fontFamily = p.fontFamily
            }
            invoke('pty_kill', { id }).catch(() => {})
            term.reset()
            spawnShell(p.shell)
            popover.classList.add('hidden')
          })
          const delBtn = document.createElement('button')
          delBtn.className = 'term-profile-del'
          delBtn.textContent = '×'
          delBtn.addEventListener('click', () => { removeProfile(p.id); renderProfiles() })
          row.append(nameBtn, delBtn)
          list.appendChild(row)
        })
        profilesSection.appendChild(list)
      }

      const saveBtn = document.createElement('button')
      saveBtn.className = 'term-profile-save'
      saveBtn.textContent = '+ Guardar perfil actual'
      saveBtn.addEventListener('click', () => {
        const name = prompt('Nombre del perfil:')
        if (!name?.trim()) return
        addProfile({
          name: name.trim(),
          shell: shellSelect.value,
          theme: localTheme,
          fontSize: term.options.fontSize ?? BASE_FONT_SIZE,
          fontFamily: localFontFamily !== DEFAULT_FONT_FAMILY ? localFontFamily : undefined,
        })
        renderProfiles()
      })
      profilesSection.appendChild(saveBtn)
    }

    renderProfiles()
    popover.appendChild(profilesSection)
  }

  root.appendChild(maxBtn)

  return { element: root, fit, focus: () => term.focus(), dispose, onTitleChange, onReady, getCwd: () => lastCwd || undefined }
}
