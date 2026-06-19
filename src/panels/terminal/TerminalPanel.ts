import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import 'xterm/css/xterm.css'

let ptyCounter = 0

export function createTerminalPanel(): HTMLElement {
  const root = document.createElement('div')
  root.className = 'terminal-panel'

  const term = new Terminal({ cursorBlink: true, fontSize: 14 })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(root)
  fitAddon.fit()

  const id = `pty-${++ptyCounter}`
  const shell = navigator.platform.includes('Win') ? 'powershell.exe' : '/bin/bash'

  invoke('pty_spawn', { id, shell, rows: term.rows, cols: term.cols })
    .catch(err => term.writeln(`\r\n\x1b[31mError PTY: ${err}\x1b[0m`))

  listen<string>(`pty-output-${id}`, event => term.write(event.payload))

  term.onData(data => {
    invoke('pty_write', { id, data }).catch(() => {})
  })

  root.addEventListener('click', () => term.focus())
  setTimeout(() => term.focus(), 100)

  const observer = new ResizeObserver(() => {
    fitAddon.fit()
    invoke('pty_resize', { id, rows: term.rows, cols: term.cols }).catch(() => {})
  })
  observer.observe(root)

  return root
}
