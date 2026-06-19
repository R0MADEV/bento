// xterm.js wrapper + PTY bridge — Fase 4
// TODO: Integrate xterm.js with Tauri PTY plugin

import { Terminal } from 'xterm'

export class TerminalPanel {
  private terminal: Terminal
  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    this.terminal = new Terminal()
  }

  open(): void {
    this.terminal.open(this.container)
  }

  write(data: string): void {
    this.terminal.write(data)
  }

  dispose(): void {
    this.terminal.dispose()
  }
}
