import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { errorLines, isErrorLine } from '../../core/docker/logFilter'
import { askAi } from '../../ui/askAi'
import { createTerminalPanel } from '../terminal/TerminalPanel'
import { icon } from '../../ui/icons'
import type { Container } from '../../core/docker/containers'

export interface DetailLifecycle {
  pause: () => void
  resume: () => void
  dispose: () => void
}

const noOp = (): void => {}

function btn(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'docker-action'
  b.title = title
  b.innerHTML = icon(name)
  b.addEventListener('click', e => { e.stopPropagation(); onClick() })
  return b
}

// Renders logs for a container into `target`. Live streaming can be paused while
// its panel is hidden without confusing that temporary pause with disposal.
export function renderContainerLogs(c: Container, target: HTMLElement): DetailLifecycle {
  const pre = document.createElement('pre')
  pre.className = 'docker-logs'
  let rawLogs = '', errorsOnly = false, live = false
  let unlisten: (() => void) | null = null
  let resumeLive = false
  let disposed = false
  let streamGeneration = 0

  const applyStatic = (): void => {
    pre.textContent = errorsOnly
      ? (errorLines(rawLogs).join('\n') || i18nT('docker.noErrorsInTheLatestLogs'))
      : (rawLogs || i18nT('docker.noLogs'))
    pre.scrollTop = pre.scrollHeight
  }
  const loadStatic = async (): Promise<void> => {
    pre.textContent = i18nT('common.loading')
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
  const stopLiveStream = (): void => {
    if (!live) return
    live = false
    streamGeneration += 1
    liveBtn.innerHTML = icon('play'); liveBtn.title = i18nT('docker.followLiveLogs'); liveBtn.classList.remove('active')
    invoke('docker_logs_stop', { id: c.name }).catch(() => {})
    unlisten?.(); unlisten = null
  }
  const stopLive = (): void => {
    resumeLive = false
    stopLiveStream()
  }
  const startLive = async (): Promise<void> => {
    if (disposed || live) return
    const generation = ++streamGeneration
    live = true
    liveBtn.innerHTML = icon('stop'); liveBtn.title = i18nT('docker.stopFollowing'); liveBtn.classList.add('active')
    rawLogs = ''; pre.textContent = ''
    try {
      await invoke('docker_logs_follow', { id: c.name, tail: 200 })
      const stopListening = await listen<string>(`docker-logs-${c.name}`, e => onChunk(e.payload))
      if (disposed || !live || generation !== streamGeneration) stopListening()
      else unlisten = stopListening
    } catch (e) { pre.textContent = String(e) }
  }

  const liveBtn = btn('play', i18nT('docker.followLiveLogs'), () => live ? stopLive() : startLive())
  const errBtn = btn('alert', 'Solo errores', () => {
    errorsOnly = !errorsOnly; errBtn.classList.toggle('active', errorsOnly)
    if (!live) applyStatic()
  })
  const refreshBtn = btn('refresh', i18nT('common.reload'), () => { if (live) { stopLive(); startLive() } else loadStatic() })
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
  head.append(Object.assign(document.createElement('span'), { textContent: i18nT('docker.logs') }), liveBtn, errBtn, refreshBtn, aiBtn)

  target.replaceChildren(head, pre)
  loadStatic()
  return {
    pause: () => {
      resumeLive = live
      stopLiveStream()
    },
    resume: () => {
      if (!resumeLive || disposed) return
      resumeLive = false
      void startLive()
    },
    dispose: () => {
      disposed = true
      resumeLive = false
      stopLiveStream()
    },
  }
}

// Interactive terminals deliberately stay alive while their panel is hidden.
export async function renderContainerTerminal(c: Container, target: HTMLElement, onBack?: () => void): Promise<DetailLifecycle> {
  const argv = await invoke<string[]>('docker_exec_argv', { container: c.name }).catch(() => null)
  if (!argv) {
    target.replaceChildren(Object.assign(document.createElement('div'), { className: 'docker-detail-hint', textContent: i18nT('docker.couldNotOpenTheTerminal') }))
    return { pause: noOp, resume: noOp, dispose: noOp }
  }
  const term = createTerminalPanel('', '', onBack, argv)
  const wrap = document.createElement('div')
  wrap.className = 'docker-term'
  wrap.appendChild(term.element)
  target.replaceChildren(wrap)
  requestAnimationFrame(() => term.fit())
  return { pause: noOp, resume: () => term.fit(), dispose: () => term.dispose() }
}
