import { invoke } from '@tauri-apps/api/core'
import { parseContainers, isRunning, groupByProject, runningCount, type Container, type ProjectGroup } from '../../core/docker/containers'
import { icon } from '../../ui/icons'

export function createDockerPanel(): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'docker-panel'

  const show = (...nodes: HTMLElement[]): void => root.replaceChildren(...nodes)

  const note = (text: string, cls = 'docker-note'): HTMLElement => {
    const el = document.createElement('div')
    el.className = cls
    el.textContent = text
    return el
  }

  const header = (title: string, ...actions: HTMLElement[]): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = 'docker-header'
    const h = document.createElement('span')
    h.className = 'docker-title'
    h.textContent = title
    bar.append(h, ...actions)
    return bar
  }

  const iconBtn = (name: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'docker-action'
    b.title = title
    b.innerHTML = icon(name)
    b.addEventListener('click', e => { e.stopPropagation(); onClick() })
    return b
  }

  const renderLogs = async (c: Container): Promise<void> => {
    const back = iconBtn('arrow-left', 'Volver', () => renderList())
    const pre = document.createElement('pre')
    pre.className = 'docker-logs'
    pre.textContent = 'Cargando logs…'
    const load = async (): Promise<void> => {
      try {
        const out = await invoke<string>('docker_logs', { id: c.name, tail: 300 })
        pre.textContent = out || '(sin logs)'
        pre.scrollTop = pre.scrollHeight
      } catch (e) {
        pre.textContent = String(e)
      }
    }
    show(header(c.name, iconBtn('refresh', 'Recargar', load), back), pre)
    load()
  }

  const renderContainer = (c: Container): HTMLElement => {
    const card = document.createElement('div')
    card.className = 'docker-item'
    const dot = document.createElement('span')
    dot.className = `docker-dot ${isRunning(c) ? 'docker-up' : 'docker-down'}`
    const info = document.createElement('div')
    info.className = 'docker-info'
    const name = document.createElement('div')
    name.className = 'docker-name'
    name.textContent = c.name
    const meta = document.createElement('div')
    meta.className = 'docker-meta'
    meta.textContent = `${c.image} · ${c.status}`
    info.append(name, meta)

    const actions = document.createElement('div')
    actions.className = 'docker-actions'
    const run = async (cmd: string, label: string): Promise<void> => {
      meta.textContent = `${label}…`
      actions.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = true })
      try { await invoke(cmd, { id: c.name }) } catch (e) { alert(String(e)) }
      renderList()
    }
    if (isRunning(c)) {
      actions.append(
        iconBtn('stop', 'Parar', () => run('docker_stop', 'Parando')),
        iconBtn('power', 'Reiniciar (para y arranca)', () => run('docker_restart', 'Reiniciando')),
      )
    } else {
      actions.append(iconBtn('play', 'Arrancar', () => run('docker_start', 'Arrancando')))
    }
    actions.append(iconBtn('list', 'Logs', () => renderLogs(c)))

    card.append(dot, info, actions)
    return card
  }

  // Start or stop every container in a project at once.
  const projectAction = async (cmd: string, containers: Container[], head: HTMLElement): Promise<void> => {
    head.querySelectorAll('button').forEach(b => { (b as HTMLButtonElement).disabled = true })
    const targets = containers.filter(c => cmd === 'docker_start' ? !isRunning(c) : isRunning(c))
    for (const c of targets) {
      try { await invoke(cmd, { id: c.name }) } catch { /* sigue con los demás */ }
    }
    renderList()
  }

  const renderProject = (g: ProjectGroup): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'docker-group'
    const head = document.createElement('div')
    head.className = 'docker-group-head'

    const chevron = document.createElement('span')
    chevron.className = 'docker-chevron'
    chevron.innerHTML = icon('chevron')
    const title = document.createElement('span')
    title.className = 'docker-group-name'
    title.textContent = g.project || 'Sin proyecto'
    const running = runningCount(g.containers)
    const count = document.createElement('span')
    count.className = 'docker-count'
    count.textContent = `${running}/${g.containers.length}`

    const children = document.createElement('div')
    children.className = 'docker-children'

    const acts = document.createElement('span')
    acts.className = 'docker-group-actions'
    if (running < g.containers.length) acts.append(iconBtn('play', 'Arrancar todo el proyecto', () => projectAction('docker_start', g.containers, head)))
    if (running > 0) acts.append(iconBtn('stop', 'Parar todo el proyecto', () => projectAction('docker_stop', g.containers, head)))

    head.append(chevron, title, count, acts)
    head.addEventListener('click', () => {
      const open = children.classList.toggle('hidden')
      head.classList.toggle('collapsed', open)
    })

    g.containers.forEach(c => children.appendChild(renderContainer(c)))
    wrap.append(head, children)
    return wrap
  }

  const renderList = async (): Promise<void> => {
    const refresh = iconBtn('refresh', 'Recargar', () => renderList())
    const list = document.createElement('div')
    list.className = 'docker-list'
    list.append(note('Cargando…'))
    show(header('Docker', refresh), list)
    try {
      const containers = parseContainers(await invoke<string>('docker_list'))
      list.replaceChildren()
      if (!containers.length) {
        list.append(note('No hay contenedores. ¿Está Docker corriendo?', 'docker-hint'))
        return
      }
      groupByProject(containers).forEach(g => list.appendChild(renderProject(g)))
    } catch (e) {
      list.replaceChildren(note(String(e), 'docker-error'))
    }
  }

  renderList()
  return { element: root }
}
