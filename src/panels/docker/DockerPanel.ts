import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { parseContainers, isRunning, groupByProject, runningCount, type Container } from '../../core/docker/containers'
import { errorLines, isErrorLine } from '../../core/docker/logFilter'
import { createTerminalPanel } from '../terminal/TerminalPanel'
import { createMasterDetail, type MdItem } from '../../ui/masterDetail'
import { icon } from '../../ui/icons'

export function createDockerPanel(): { element: HTMLElement; dispose: () => void } {
  let containers: Container[] = []
  // Teardown for the current detail's body (live stream / exec terminal).
  let bodyCleanup: () => void = () => {}

  const iconBtn = (name: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'docker-action'
    b.title = title
    b.innerHTML = icon(name)
    b.addEventListener('click', e => { e.stopPropagation(); onClick() })
    return b
  }

  const find = (name: string): Container | undefined => containers.find(c => c.name === name)
  const byProject = (project: string): Container[] => containers.filter(c => (c.project || 'Sin proyecto') === project)

  const run = async (cmd: string, name: string): Promise<void> => {
    try { await invoke(cmd, { id: name }) } catch (e) { alert(String(e)) }
    load()
  }

  const projectAction = async (cmd: string, project: string): Promise<void> => {
    const targets = byProject(project).filter(c => cmd === 'docker_start' ? !isRunning(c) : isRunning(c))
    for (const c of targets) {
      try { await invoke(cmd, { id: c.name }) } catch { /* sigue */ }
    }
    load()
  }

  const md = createMasterDetail({
    title: 'Contenedores',
    collapsibleGroups: true,
    emptyText: 'No hay contenedores. ¿Está Docker corriendo?',
    headerActions: [iconBtn('refresh', 'Recargar', () => load())],
    groupBadge: (_p, ids) => `${runningCount(ids.map(find).filter(Boolean) as Container[])}/${ids.length}`,
    groupActions: project => {
      const group = byProject(project)
      const running = runningCount(group)
      const acts: HTMLElement[] = []
      if (running < group.length) acts.push(iconBtn('play', 'Arrancar el proyecto', () => projectAction('docker_start', project)))
      if (running > 0) acts.push(iconBtn('stop', 'Parar el proyecto', () => projectAction('docker_stop', project)))
      return acts
    },
    onSelect: renderDetail,
  })

  const dot = (c: Container): HTMLElement => {
    const d = document.createElement('span')
    d.className = `docker-dot ${isRunning(c) ? 'docker-up' : 'docker-down'}`
    return d
  }

  // ---- logs (static + live follow) ----
  function showLogs(body: HTMLElement, c: Container): void {
    bodyCleanup()
    const pre = document.createElement('pre')
    pre.className = 'docker-logs'
    let rawLogs = ''
    let errorsOnly = false
    let live = false
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
    const setLiveBtn = (): void => {
      liveBtn.innerHTML = icon(live ? 'stop' : 'play')
      liveBtn.title = live ? 'Parar el seguimiento' : 'Seguir logs en vivo'
      liveBtn.classList.toggle('active', live)
    }
    const startLive = async (): Promise<void> => {
      live = true
      setLiveBtn()
      rawLogs = ''
      pre.textContent = ''
      try {
        await invoke('docker_logs_follow', { id: c.name, tail: 200 })
        unlisten = await listen<string>(`docker-logs-${c.name}`, e => onChunk(e.payload))
      } catch (e) {
        pre.textContent = String(e)
      }
    }
    const stopLive = (): void => {
      if (!live) return
      live = false
      setLiveBtn()
      invoke('docker_logs_stop', { id: c.name }).catch(() => {})
      unlisten?.()
      unlisten = null
    }

    const liveBtn = iconBtn('play', 'Seguir logs en vivo', () => (live ? stopLive() : startLive()))
    const errBtn = iconBtn('alert', 'Solo errores', () => {
      errorsOnly = !errorsOnly
      errBtn.classList.toggle('active', errorsOnly)
      if (!live) applyStatic()
    })
    const refreshBtn = iconBtn('refresh', 'Recargar', () => { if (live) { stopLive(); startLive() } else loadStatic() })

    const logsHead = document.createElement('div')
    logsHead.className = 'docker-logs-head'
    const t = document.createElement('span')
    t.textContent = 'Logs'
    logsHead.append(t, liveBtn, errBtn, refreshBtn)

    body.replaceChildren(logsHead, pre)
    bodyCleanup = stopLive
    loadStatic()
  }

  // ---- exec terminal (shell inside the container) ----
  async function showTerminal(body: HTMLElement, c: Container, backToLogs: () => void): Promise<void> {
    bodyCleanup()
    const argv = await invoke<string[]>('docker_exec_argv', { container: c.name }).catch(() => null)
    if (!argv) {
      body.replaceChildren(Object.assign(document.createElement('div'), { className: 'docker-detail-hint', textContent: 'No se pudo abrir la terminal.' }))
      return
    }
    const term = createTerminalPanel('', '', backToLogs, argv)
    const wrap = document.createElement('div')
    wrap.className = 'docker-term'
    wrap.appendChild(term.element)
    body.replaceChildren(wrap)
    requestAnimationFrame(() => term.fit())
    bodyCleanup = () => term.dispose()
  }

  function renderDetail(name: string): void {
    bodyCleanup()
    bodyCleanup = () => {}
    const c = find(name)
    if (!c) {
      md.detail.replaceChildren(Object.assign(document.createElement('div'), { className: 'docker-detail-hint', textContent: 'Selecciona un contenedor para ver sus detalles y logs.' }))
      return
    }

    const body = document.createElement('div')
    body.className = 'docker-body'
    let mode: 'logs' | 'terminal' = 'logs'
    const goLogs = (): void => { mode = 'logs'; modeBtn.innerHTML = icon('terminal'); modeBtn.title = 'Abrir terminal'; showLogs(body, c) }
    const goTerminal = (): void => { mode = 'terminal'; modeBtn.innerHTML = icon('list'); modeBtn.title = 'Ver logs'; showTerminal(body, c, goLogs) }
    const modeBtn = iconBtn('terminal', 'Abrir terminal', () => (mode === 'logs' ? goTerminal() : goLogs()))

    const head = document.createElement('div')
    head.className = 'docker-detail-head'
    const titleWrap = document.createElement('div')
    titleWrap.className = 'docker-detail-title-wrap'
    const title = document.createElement('span')
    title.className = 'docker-detail-title'
    title.textContent = c.name
    titleWrap.append(dot(c), title)
    const actions = document.createElement('div')
    actions.className = 'docker-detail-actions'
    if (isRunning(c)) {
      actions.append(
        iconBtn('stop', 'Parar', () => run('docker_stop', c.name)),
        iconBtn('power', 'Reiniciar (para y arranca)', () => run('docker_restart', c.name)),
        modeBtn,
      )
    } else {
      actions.append(iconBtn('play', 'Arrancar', () => run('docker_start', c.name)))
    }
    head.append(titleWrap, actions)

    const info = document.createElement('div')
    info.className = 'docker-detail-info'
    info.innerHTML =
      `<span>${c.image}</span><span class="docker-detail-status">${c.status}</span>` +
      (c.ports ? `<span class="docker-detail-ports">${c.ports}</span>` : '')

    md.detail.replaceChildren(head, info, body)
    showLogs(body, c)
  }

  const toItems = (): MdItem[] =>
    groupByProject(containers).flatMap(g =>
      g.containers.map(c => ({ id: c.name, label: c.name, group: g.project || 'Sin proyecto', leading: dot(c) })),
    )

  const load = async (): Promise<void> => {
    try {
      containers = parseContainers(await invoke<string>('docker_list'))
    } catch {
      containers = []
    }
    md.setItems(toItems())
    if (md.selected()) renderDetail(md.selected())
  }

  load()
  return { element: md.element, dispose: () => bodyCleanup() }
}
