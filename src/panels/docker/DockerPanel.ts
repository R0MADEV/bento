import { invoke } from '@tauri-apps/api/core'
import { parseContainers, isRunning, groupByProject, runningCount, type Container } from '../../core/docker/containers'
import { renderContainerLogs, renderContainerTerminal } from './containerDetail'
import { createMasterDetail, type MdItem } from '../../ui/masterDetail'
import { icon } from '../../ui/icons'

export function createDockerPanel(filterPrefix?: string): { element: HTMLElement; dispose: () => void } {
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
      try { await invoke(cmd, { id: c.name }) } catch { /* keep going */ }
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

  // ---- logs + terminal: delegated to shared containerDetail module ----
  function showLogs(body: HTMLElement, c: Container): void {
    bodyCleanup()
    bodyCleanup = renderContainerLogs(c, body)
  }

  async function showTerminal(body: HTMLElement, c: Container, backToLogs: () => void): Promise<void> {
    bodyCleanup()
    bodyCleanup = await renderContainerTerminal(c, body, backToLogs)
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
      const all = parseContainers(await invoke<string>('docker_list'))
      containers = filterPrefix ? all.filter(c => c.name.startsWith(filterPrefix)) : all
    } catch {
      containers = []
    }
    md.setItems(toItems())
    if (md.selected()) renderDetail(md.selected())
  }

  load()
  return { element: md.element, dispose: () => bodyCleanup() }
}
