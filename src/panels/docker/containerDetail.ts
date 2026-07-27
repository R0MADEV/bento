import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { errorLines, isErrorLine } from '../../core/docker/logFilter'
import { askAi } from '../../ui/askAi'
import { createTerminalPanel } from '../terminal/TerminalPanel'
import { icon } from '../../ui/icons'
import type { Container } from '../../core/docker/containers'

function btn(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'docker-action'
  b.title = title
  b.innerHTML = icon(name)
  b.addEventListener('click', e => { e.stopPropagation(); onClick() })
  return b
}

// Renders logs for a container into `target`. Returns a cleanup (stops live stream).
export function renderContainerLogs(c: Container, target: HTMLElement): () => void {
  const pre = document.createElement('pre')
  pre.className = 'docker-logs'
  let rawLogs = '', errorsOnly = false, live = false
  let unlisten: (() => void) | null = null

  const applyStatic = (): void => {
    pre.textContent = errorsOnly
      ? (errorLines(rawLogs).join('\n') || '(sin errores en los últimos logs)')
      : (rawLogs || '(sin logs)')
    pre.scrollTop = pre.scrollHeight
  }
  const loadStatic = async (): Promise<void> => {
    pre.textContent = 'Cargando…'
    try { rawLogs = await invoke<string>('docker_logs', { id: c.name, tail: 500 }) } catch (e) { rawLogs = String(e) }
    applyStatic()
  }
  const onChunk = (chunk: string): void => {
    rawLogs += chunk
    const text = errorsOnly ? chunk.split('\n').filter(isErrorLine).map(l => `${l}\n`).join('') : chunk
    if (!text) return
    pre.textContent += text
    pre.scrollTop = pre.scrollHeight
  }
  const stopLive = (): void => {
    if (!live) return
    live = false
    liveBtn.innerHTML = icon('play'); liveBtn.title = 'Seguir logs en vivo'; liveBtn.classList.remove('active')
    invoke('docker_logs_stop', { id: c.name }).catch(() => {})
    unlisten?.(); unlisten = null
  }
  const startLive = async (): Promise<void> => {
    live = true
    liveBtn.innerHTML = icon('stop'); liveBtn.title = 'Parar el seguimiento'; liveBtn.classList.add('active')
    rawLogs = ''; pre.textContent = ''
    try {
      await invoke('docker_logs_follow', { id: c.name, tail: 200 })
      unlisten = await listen<string>(`docker-logs-${c.name}`, e => onChunk(e.payload))
    } catch (e) { pre.textContent = String(e) }
  }

  const liveBtn = btn('play', 'Seguir logs en vivo', () => live ? stopLive() : startLive())
  const errBtn = btn('alert', 'Solo errores', () => {
    errorsOnly = !errorsOnly; errBtn.classList.toggle('active', errorsOnly)
    if (!live) applyStatic()
  })
  const refreshBtn = btn('refresh', 'Recargar', () => { if (live) { stopLive(); startLive() } else loadStatic() })
  const sendToAi = (): void => {
    const sel = window.getSelection()?.toString().trim()
    const content = (sel || errorLines(rawLogs).join('\n') || rawLogs).slice(-16000)
    if (content.trim()) askAi(`/explica estos logs de Docker:\n\n\`\`\`\n${content}\n\`\`\``, true)
  }
  const aiBtn = btn('chat', 'Explicar errores con IA (⌘⇧E)', sendToAi)

  pre.tabIndex = 0
  pre.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); sendToAi() }
  })

  const head = document.createElement('div')
  head.className = 'docker-logs-head'
  head.append(Object.assign(document.createElement('span'), { textContent: 'Logs' }), liveBtn, errBtn, refreshBtn, aiBtn)

  target.replaceChildren(head, pre)
  loadStatic()
  return stopLive
}

// Renders a docker exec terminal into `target`. Returns a cleanup (disposes terminal).
export async function renderContainerTerminal(c: Container, target: HTMLElement, onBack?: () => void): Promise<() => void> {
  const argv = await invoke<string[]>('docker_exec_argv', { container: c.name }).catch(() => null)
  if (!argv) {
    target.replaceChildren(Object.assign(document.createElement('div'), { className: 'docker-detail-hint', textContent: 'No se pudo abrir la terminal.' }))
    return () => {}
  }
  const term = createTerminalPanel('', '', onBack, argv)
  const wrap = document.createElement('div')
  wrap.className = 'docker-term'
  wrap.appendChild(term.element)
  target.replaceChildren(wrap)
  requestAnimationFrame(() => term.fit())
  return () => term.dispose()
}
