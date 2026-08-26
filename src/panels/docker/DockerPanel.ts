import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { parseContainers, isRunning, groupByProject, runningCount, type Container } from '../../core/docker/containers'
import { renderContainerLogs, renderContainerTerminal, type DetailLifecycle } from './containerDetail'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { icon } from '../../ui/helpers/icons'

export function createDockerPanel(filterPrefix?: string): { element: HTMLElement; dispose: () => void } {
  let containers: Container[] = []
  // Teardown for the current detail's body (live stream / exec terminal).
  const emptyLifecycle = (): DetailLifecycle => ({ pause: () => {}, resume: () => {}, dispose: () => {} })
  let bodyLifecycle = emptyLifecycle()

  const iconBtn = (name: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'docker-action'
    b.title = title
    b.innerHTML = icon(name)
    b.addEventListener('click', e => { e.stopPropagation(); onClick() })
    return b
  }

  const find = (name: string): Container | undefined => containers.find(c => c.name === name)
  const byProject = (project: string): Container[] => containers.filter(c => (c.project || i18nT('docker.noProject')) === project)

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

  // ---- collapsible sidebar (containers, grouped by project) + detail ----
  const root = document.createElement('div')
  root.className = 'docker-panel'

  const cs = createCollapsibleSidebar({
    storageKey: 'bento.docker.sidebar',
    title: i18nT('docker.containers'),
    defaultWidth: 220,
    minWidth: 180,
    minRemaining: 320,
    container: root,
  })
  cs.actions.append(iconBtn('refresh', i18nT('common.reload'), () => load()))
  Object.assign(cs.list.style, { padding: '6px' })

  const detail = document.createElement('div')
  detail.className = 'docker-detail-pane'
  detail.append(Object.assign(document.createElement('div'), { className: 'docker-detail-hint', textContent: i18nT('docker.selectAContainerToViewItsDetailsAnd') }))
  root.append(cs.element, cs.resizer, detail)

  const collapsedGroups = new Set<string>()
  let selectedName = ''

  const select = (name: string): void => {
    selectedName = name
    renderList()
    renderDetail(name)
  }

  // Grouped, collapsible container list rendered into the sidebar.
  const renderList = (): void => {
    cs.list.replaceChildren()
    const groups = groupByProject(containers)
    if (!groups.length) {
      cs.list.append(Object.assign(document.createElement('div'), { className: 'md-empty', textContent: i18nT('docker.thereAreNoContainersIsDockerRunning') }))
      cs.setMiniItems([])
      return
    }
    for (const g of groups) {
      const project = g.project || i18nT('docker.noProject')
      const isCollapsed = collapsedGroups.has(project)
      const cat = document.createElement('div')
      cat.className = 'md-cat md-cat-toggle'
      const chevron = document.createElement('span')
      chevron.className = isCollapsed ? 'md-cat-chevron collapsed' : 'md-cat-chevron'
      chevron.innerHTML = icon('chevron')
      const nameEl = Object.assign(document.createElement('span'), { className: 'md-cat-name', textContent: project })
      const badge = Object.assign(document.createElement('span'), { className: 'md-cat-badge', textContent: `${runningCount(g.containers)}/${g.containers.length}` })
      cat.append(chevron, nameEl, badge)
      const running = runningCount(g.containers)
      const acts: HTMLElement[] = []
      if (running < g.containers.length) acts.push(iconBtn('play', i18nT('docker.startProject'), () => projectAction('docker_start', project)))
      if (running > 0) acts.push(iconBtn('stop', i18nT('docker.stopProject'), () => projectAction('docker_stop', project)))
      if (acts.length) {
        const wrap = Object.assign(document.createElement('span'), { className: 'md-cat-actions' })
        wrap.append(...acts)
        cat.append(wrap)
      }
      cat.addEventListener('click', () => {
        if (collapsedGroups.has(project)) collapsedGroups.delete(project)
        else collapsedGroups.add(project)
        renderList()
      })
      cs.list.append(cat)
      if (isCollapsed) continue
      for (const c of g.containers) {
        const item = document.createElement('button')
        item.className = c.name === selectedName ? 'md-item active' : 'md-item'
        item.append(dot(c), Object.assign(document.createElement('span'), { className: 'md-item-name', textContent: c.name }))
        item.addEventListener('click', () => select(c.name))
        cs.list.append(item)
      }
    }
    cs.setMiniItems(containers.map(c => ({
      label: c.name,
      dot: isRunning(c) ? 'working' : undefined,
      active: c.name === selectedName,
      onClick: () => select(c.name),
    })))
  }

  const dot = (c: Container): HTMLElement => {
    const d = document.createElement('span')
    d.className = `docker-dot ${isRunning(c) ? 'docker-up' : 'docker-down'}`
    return d
  }

  // ---- logs + terminal: delegated to shared containerDetail module ----
  function showLogs(body: HTMLElement, c: Container): void {
    bodyLifecycle.dispose()
    bodyLifecycle = renderContainerLogs(c, body)
  }

  async function showTerminal(body: HTMLElement, c: Container, backToLogs: () => void): Promise<void> {
    bodyLifecycle.dispose()
    bodyLifecycle = await renderContainerTerminal(c, body, backToLogs)
  }

  function renderDetail(name: string): void {
    bodyLifecycle.dispose()
    bodyLifecycle = emptyLifecycle()
    const c = find(name)
    if (!c) {
      detail.replaceChildren(Object.assign(document.createElement('div'), { className: 'docker-detail-hint', textContent: i18nT('docker.selectAContainerToViewItsDetailsAnd') }))
      return
    }

    const body = document.createElement('div')
    body.className = 'docker-body'
    let mode: 'logs' | 'terminal' = 'logs'
    const goLogs = (): void => { mode = 'logs'; modeBtn.innerHTML = icon('terminal'); modeBtn.title = i18nT('docker.openTerminal'); showLogs(body, c) }
    const goTerminal = (): void => { mode = 'terminal'; modeBtn.innerHTML = icon('list'); modeBtn.title = i18nT('docker.viewLogs'); showTerminal(body, c, goLogs) }
    const modeBtn = iconBtn('terminal', i18nT('docker.openTerminal'), () => (mode === 'logs' ? goTerminal() : goLogs()))

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
        iconBtn('stop', i18nT('docker.stop'), () => run('docker_stop', c.name)),
        iconBtn('power', i18nT('docker.restartProject'), () => run('docker_restart', c.name)),
        modeBtn,
      )
    } else {
      actions.append(iconBtn('play', i18nT('docker.start'), () => run('docker_start', c.name)))
    }
    head.append(titleWrap, actions)

    const info = document.createElement('div')
    info.className = 'docker-detail-info'
    info.innerHTML =
      `<span>${c.image}</span><span class="docker-detail-status">${c.status}</span>` +
      (c.ports ? `<span class="docker-detail-ports">${c.ports}</span>` : '')

    detail.replaceChildren(head, info, body)
    showLogs(body, c)
  }

  const load = async (): Promise<void> => {
    try {
      const all = parseContainers(await invoke<string>('docker_list'))
      containers = filterPrefix ? all.filter(c => c.name.startsWith(filterPrefix)) : all
    } catch {
      containers = []
    }
    renderList()
    if (selectedName) renderDetail(selectedName)
  }

  load()
  return { element: root, dispose: () => bodyLifecycle.dispose() }
}
