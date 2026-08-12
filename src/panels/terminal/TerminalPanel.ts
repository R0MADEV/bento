import { t as i18nT } from '../../i18n'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import { SearchAddon } from 'xterm-addon-search'
import { Unicode11Addon } from 'xterm-addon-unicode11'
import { SerializeAddon } from 'xterm-addon-serialize'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getTheme, themeNames } from '../../core/terminal/themes'
import { mix, isDark } from '../../core/terminal/color'
import { dimsChanged, type Dims } from '../../core/terminal/dims'
import { splitAtSyncBoundary } from '../../core/terminal/syncOutput'
import { getThemeName, onThemeChange } from './themePreference'
import { nextTheme } from '../../core/terminal/nextTheme'
import type { TerminalProfile } from '../../core/terminal/profiles'
import { createActivityTracker } from '../../core/terminal/activityTracker'
import { createAgentStatusTracker } from '../../core/terminal/agentStatusTracker'
import type { AgentStore } from '../../core/terminal/agentStore'
import { parseOsc7Path, toDisplayPath } from '../../core/terminal/osc7'
import { createSearchBar } from './searchBar'
import { createTerminalAppearanceControls } from './appearanceControls'
import { createTerminalProfileControls } from './profileControls'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'
import type { PanelApi } from '../registry'
import 'xterm/css/xterm.css'

const CWD_KEY = (id: string) => `bento.terminal.cwd.${id}`

let ptyCounter = 0

function showCommandDoneToast(termRoot: HTMLElement): void {
  const existing = termRoot.querySelector('.term-toast')
  if (existing) return
  const toast = document.createElement('div')
  toast.className = 'term-toast'
  toast.textContent = i18nT('terminal.commandFinished')
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
  sendInput: (text: string) => void
  onInput: (cb: (line: string) => void) => () => void
  onBell: (cb: () => void) => () => void
  getSnapshot: () => string
  writeSnapshot: (data: string) => void
  getPtyId: () => string
}

const DEFAULT_FONT_FAMILY = '"JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", "Hack Nerd Font", "CaskaydiaCove Nerd Font", "Symbols Nerd Font", "JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Monaco, monospace'

export function createTerminalPanel(panelId = '', projectPath = '', onExit?: () => void, execCommand?: string[], store?: AgentStore, newSibling?: () => void): TerminalPanelHandle {
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
    scrollback: 2000,
    theme: getTheme(getThemeName()),
  })

  let localTheme = getThemeName()
  let followGlobal = true

  let titleCallback: ((title: string) => void) | undefined
  const tracker = createActivityTracker(t => titleCallback?.(t))
  // focusin bubbles from xterm's internal textarea — public API has no onFocus
  const onRootFocus = () => tracker.onFocus()
  root.addEventListener('focusin', onRootFocus)

  const agentStatus = createAgentStatusTracker()
  agentStatus.onChange(status => {
    store?.setStatus(id, status)
  })

  const applyBackground = (background: string): void => {
    // xterm DOM renderer: update the viewport directly (it doesn't wait for activity)
    const viewport = root.querySelector<HTMLElement>('.xterm-viewport')
    if (viewport) viewport.style.backgroundColor = background
    root.style.backgroundColor = background
    term.refresh(0, term.rows - 1)

    // The group's tab bar uses --surface (derived from the global theme).
    // When the local theme changes, it must be overridden on the .dv-groupview
    // so the header reflects the color of this terminal's new theme.
    const groupView = root.closest<HTMLElement>('.dv-groupview')
    if (groupView) {
      const shade = isDark(background) ? '#ffffff' : '#000000'
      groupView.style.setProperty('--surface', mix(background, shade, 0.05))
    }
  }

  const applyLocalTheme = (name: string): void => {
    const theme = getTheme(name)
    term.options.theme = theme
    applyBackground(theme.background)
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
    applyBackground(bg)
  }

  const appearance = createTerminalAppearanceControls({
    themeName: localTheme,
    onThemeSelected: name => {
      followGlobal = false
      localTheme = name
      applyLocalTheme(name)
    },
    onCustomBackground: applyCustomBackground,
    onShellChanged: shell => {
      restartShell(shell)
    },
    onFontChanged: font => {
      localFontFamily = font.trim() || DEFAULT_FONT_FAMILY
      term.options.fontFamily = localFontFamily
      fit()
    },
  })
  const { popover, themeButton: themeBtn, shellSelect, fontInput } = appearance
  root.append(popover, themeBtn)
  root.addEventListener('click', () => popover.classList.add('hidden'))

  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  const serializeAddon = new SerializeAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(serializeAddon)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  term.loadAddon(new WebLinksAddon((_event, uri) => {
    openUrl(uri).catch(() => {})
  }))

  term.open(root)

  fitAddon.fit()

  const searchBar = createSearchBar(searchAddon)
  root.appendChild(searchBar.element)

  const id = `pty-${++ptyCounter}`
  store?.register(id, projectPath || 'Terminal')
  let disposed = false
  const eventUnlisteners: Array<() => void> = []

  const listenTo = <T>(eventName: string, handler: Parameters<typeof listen<T>>[1]): void => {
    void listen<T>(eventName, handler).then(unlisten => {
      if (disposed) unlisten()
      else eventUnlisteners.push(unlisten)
    }).catch(() => {})
  }

  // Restore the directory the terminal was in last session, so the (restored)
  // prompt matches reality and `lexis ask` / commands run in the right project.
  // Saved cwd (restored terminal) wins; else the session's project folder.
  let lastCwd = (panelId && localStorage.getItem(CWD_KEY(panelId))) || projectPath || ''

  const spawnShell = (shellPath: string) => {
    const resolved = shellPath === 'auto' ? (navigator.platform.includes('Win') ? 'powershell.exe' : '/bin/sh') : shellPath
    invoke('pty_spawn', { id, shell: resolved, rows: term.rows, cols: term.cols, cwd: lastCwd || null, command: execCommand ?? null })
      .catch(err => term.writeln(`\r\n\x1b[31mError PTY: ${err}\x1b[0m`))
  }

  const restartShell = (shellPath: string): void => {
    invoke('pty_kill', { id }).catch(() => {})
    term.reset()
    spawnShell(shellPath)
    popover.classList.add('hidden')
  }

  spawnShell('auto')

  // A freshly-spawned shell discards input written during its startup, so
  // sendInput (Scripts panel) queues commands until the shell is ready —
  // marked ~150ms after its first output (the prompt), with a safety fallback.
  let shellReady = false
  const queuedInput: string[] = []
  const writeInput = (text: string) => invoke('pty_write', { id, data: `${text}\r` }).catch(() => {})
  const markShellReady = () => {
    if (shellReady) return
    shellReady = true
    queuedInput.forEach(writeInput)
    queuedInput.length = 0
  }
  let firstOutputSeen = false
  setTimeout(markShellReady, 1500)

  // OSC 133 shell integration: A/B = prompt, C = command start, D = command end.
  // A and B mean "shell is at the prompt" — use them to force idle so the shell
  // printing its prompt does not appear as working (fallback output-based detection
  // would otherwise trigger working on every prompt redraw).
  let commandRunning = false
  term.parser.registerOscHandler(133, data => {
    if (data.startsWith('A') || data.startsWith('B')) agentStatus.onCommandEnd()
    if (data.startsWith('C')) { commandRunning = true; agentStatus.onCommandStart() }
    const isCommandEnd = commandRunning && data.startsWith('D')
    if (isCommandEnd) {
      commandRunning = false
      agentStatus.onCommandEnd()
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
  listenTo<string>(`pty-output-${id}`, event => {
    if (!firstOutputSeen) { firstOutputSeen = true; setTimeout(markShellReady, 150) }
    pending += event.payload
    const { flush, keep } = splitAtSyncBoundary(pending)
    pending = keep
    if (flush) {
      term.write(flush)
      tracker.onOutput(root.contains(document.activeElement))
      agentStatus.onOutput()
    }
    if (safety) clearTimeout(safety)
    // Never hold an unterminated frame indefinitely (spec uses a ~150ms cap).
    safety = pending ? setTimeout(() => { term.write(pending); pending = '' }, 150) : undefined
  })

  // The shell exited on its own (the user typed `exit`): close the panel. Skip
  // if we're already disposing (closing the panel kills the PTY, firing this too).
  listenTo(`pty-exit-${id}`, () => { if (!disposed) onExit?.() })

  let inputCallback: ((line: string) => void) | undefined
  let inputBuffer = ''

  term.onData(data => {
    invoke('pty_write', { id, data }).catch(() => {})
    if (!inputCallback) return
    if (data === '\r' || data === '\n') {
      const line = inputBuffer.trim()
      if (line) inputCallback(line)
      inputBuffer = ''
    } else if (data === '\x7f' || data === '\b') {
      inputBuffer = inputBuffer.slice(0, -1)
    } else if (data === '\x15') {
      inputBuffer = '' // Ctrl+U clears line
    } else if (data.length === 1 && data >= ' ') {
      inputBuffer += data
    }
  })

  const onInput = (cb: (line: string) => void): (() => void) => {
    inputCallback = cb
    return () => { inputCallback = undefined; inputBuffer = '' }
  }

  // Terminal bell (\a): agents like Claude Code ring it when a turn finishes or
  // they need input/permission — a precise "this agent wants you" signal.
  let bellCallback: (() => void) | undefined
  term.onBell(() => bellCallback?.())
  const onBell = (cb: () => void): (() => void) => {
    bellCallback = cb
    return () => { bellCallback = undefined }
  }

  // Drag files/folders from Finder → paste shell-quoted paths at the cursor.
  // Uses tauri://drag-drop (dragDropEnabled: true) to get real OS paths; checks
  // that the drop landed inside this terminal by comparing position to its rect.
  listenTo<{ paths: string[]; position: { x: number; y: number } }>('tauri://drag-drop', event => {
    const { paths, position } = event.payload
    if (!paths.length) return
    const rect = root.getBoundingClientRect()
    const isOver = position.x >= rect.left && position.x <= rect.right &&
                   position.y >= rect.top  && position.y <= rect.bottom
    if (!isOver) return
    const quoted = paths.map(p =>
      /[ "'\\$`!#&;()|<>]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p
    )
    invoke('pty_write', { id, data: quoted.join(' ') }).catch(() => {})
  })

  term.onSelectionChange(() => {
    const sel = term.getSelection()
    if (!sel) return
    navigator.clipboard.writeText(sel).then(() => {
      const existing = root.querySelector('.term-copy-toast')
      if (existing) return
      const toast = document.createElement('div')
      toast.className = 'term-toast term-copy-toast'
      toast.textContent = i18nT('terminal.copied')
      root.appendChild(toast)
      setTimeout(() => toast.remove(), 1500)
    }).catch(() => {})
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
    const isAskAi = mod && e.shiftKey && e.key.toLowerCase() === 'e' && term.hasSelection()
    if (isAskAi) {
      askAi(`/explica\n\n\`\`\`\n${term.getSelection()}\n\`\`\``, true)
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
      // Skip entirely when hidden (display:none → 0×0 px). Calling fitAddon.fit()
      // on an invisible container corrupts xterm's internal state and can send a
      // 0-row SIGWINCH to the PTY, crashing TUI processes like OpenCode.
      if (root.offsetWidth === 0 && root.offsetHeight === 0) return
      fitAddon.fit()
      const dims: Dims = { rows: term.rows, cols: term.cols }
      if (dims.rows === 0 || dims.cols === 0) return
      if (!dimsChanged(lastDims, dims)) return
      lastDims = dims
      invoke('pty_resize', { id, ...dims }).catch(() => {})
    })
  }

  const observer = new ResizeObserver(fit)
  observer.observe(root)

  const dispose = () => {
    disposed = true
    if (panelId && lastCwd) {
      try { localStorage.setItem(CWD_KEY(panelId), lastCwd) } catch { /* storage full */ }
    }
    observer.disconnect()
    eventUnlisteners.splice(0).forEach(unlisten => unlisten())
    unsubscribeTheme()
    root.removeEventListener('focusin', onRootFocus)
    agentStatus.dispose()
    store?.unregister(id)
    invoke('pty_kill', { id }).catch(() => {})
    try { term.dispose() } catch { /* ignore */ }
  }

  const onTitleChange = (cb: (title: string) => void): (() => void) => {
    titleCallback = cb
    const d1 = term.onTitleChange(title => {
      if (title) { tracker.setBase(title); store?.setTitle(id, title) }
    })

    const d2 = term.parser.registerOscHandler(7, data => {
      const path = parseOsc7Path(data)
      if (path) {
        lastCwd = path
        const display = toDisplayPath(path)
        tracker.setBase(display)
        store?.setTitle(id, display)
      }
      return true
    })

    return () => { titleCallback = undefined; d1.dispose(); d2.dispose() }
  }

  const maxBtn = document.createElement('button')
  maxBtn.className = 'term-theme-btn term-max-btn'
  maxBtn.title = i18nT('terminal.maximizeRestore')
  maxBtn.innerHTML = icon('expand')

  const onReady = (panelApi: PanelApi) => {
    maxBtn.addEventListener('click', () => {
      if (panelApi.isMaximized()) panelApi.exitMaximized()
      else panelApi.maximize()
    })

    const profiles = createTerminalProfileControls({
      getSettings: () => ({
        shell: shellSelect.value,
        theme: localTheme,
        fontSize: term.options.fontSize ?? BASE_FONT_SIZE,
        fontFamily: localFontFamily !== DEFAULT_FONT_FAMILY ? localFontFamily : undefined,
      }),
      onSelect: (profile: TerminalProfile) => {
        followGlobal = false
        localTheme = profile.theme
        applyLocalTheme(profile.theme)
        setFontSize(profile.fontSize)
        if (profile.fontFamily) {
          localFontFamily = profile.fontFamily
          fontInput.value = profile.fontFamily
          term.options.fontFamily = profile.fontFamily
        }
        restartShell(profile.shell)
      },
    })
    popover.appendChild(profiles.element)
  }

  if (newSibling) {
    const addBtn = document.createElement('button')
    addBtn.className = 'term-theme-btn term-add-btn'
    addBtn.title = 'Nueva terminal'
    addBtn.textContent = '+'
    addBtn.addEventListener('click', () => newSibling())
    root.appendChild(addBtn)
  }

  root.appendChild(maxBtn)

  // Run a command here: focus and write it + Enter. If the shell is still
  // starting up, queue it (early writes get discarded) and flush when ready.
  const sendInput = (text: string) => {
    term.focus()
    if (shellReady) writeInput(text)
    else queuedInput.push(text)
  }

  return {
    element: root, fit, focus: () => term.focus(), dispose, onTitleChange, onReady,
    getCwd: () => lastCwd || undefined, sendInput, onInput, onBell,
    getSnapshot: () => { try { return serializeAddon.serialize({ scrollback: 500 }) } catch { return '' } },
    // A malformed/huge restored snapshot must not throw — that would drop the
    // agent from restore. Worst case the scrollback isn't painted; the agent
    // still restores and resumes.
    writeSnapshot: (data: string) => { if (data) { try { term.write(data) } catch { /* skip unpaintable snapshot */ } } },
    getPtyId: () => id,
  }
}
