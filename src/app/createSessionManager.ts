import type { PanelRegistry } from '../panels/registry'
import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'
import { createWorkspaceView, type WorkspaceView } from './createWorkspaceView'
import { addSession, removeSession, setActiveSession, type SessionState } from '../core/session/sessionModel'
import { createWindowControls } from '../ui/windowControls'
import { icon } from '../ui/icons'
import { createCommandPalette } from '../ui/commandPalette'
import type { Command } from '../core/command/command'
import { themeNames, themeLabels } from '../core/terminal/themes'
import { setTheme } from '../panels/terminal/themePreference'
import { isUnlocked, toggleUnlocked } from '../panels/panelLockPreference'
import { isMac } from '../ui/platform'
import { getBarPosition, setBarPosition, onBarPositionChange, type BarPosition } from '../ui/sessionBarPreference'
import { panelTitlesFromLayout } from '../core/workspace/panelTitles'

// Sesiones que se ocultan entre sí; cada una es un workspace completo.
// Persiste sesiones + layout de cada una para reabrir donde se dejó.
export function createSessionManager(panels: PanelRegistry, stateRepo: WorkspaceStateRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'session-manager'

  // macOS: la barra de título es overlay. Cuando la barra de sesiones no está
  // arriba, esta franja superior reserva el hueco de los semáforos y permite
  // arrastrar la ventana (en CSS solo se muestra si la barra no está arriba).
  if (isMac) {
    const macStrip = document.createElement('div')
    macStrip.className = 'mac-title-strip'
    root.appendChild(macStrip)
  }

  // La barra y el cuerpo viven en un contenedor cuya dirección define la
  // posición de la barra (arriba/abajo/izquierda/derecha).
  const content = document.createElement('div')
  content.className = 'session-content'

  const bar = document.createElement('div')
  bar.className = 'session-bar'

  // Zona de tabs (se redibuja) — los controles de ventana quedan fijos aparte
  const tabsArea = document.createElement('div')
  tabsArea.className = 'session-tabs'
  bar.appendChild(tabsArea)

  // Windows/Linux: controles de ventana propios (macOS usa los nativos)
  if (!isMac) bar.appendChild(createWindowControls())

  const body = document.createElement('div')
  body.className = 'session-body'

  content.append(bar, body)
  root.appendChild(content)

  // Posición configurable de la barra; reacciona a cambios desde la paleta.
  const applyBarPosition = (): void => { root.dataset.barPos = getBarPosition() }
  applyBarPosition()
  onBarPositionChange(applyBarPosition)

  const views = new Map<string, WorkspaceView>()
  let savedLayouts: Record<string, unknown> = {}
  let state: SessionState = { sessions: [], activeId: null }

  // Guardado debounced: los cambios de layout se disparan a ráfagas
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const layouts: Record<string, unknown> = { ...savedLayouts }
      views.forEach((view, id) => { layouts[id] = view.serialize() })
      savedLayouts = layouts
      stateRepo.save({ sessions: state.sessions, activeId: state.activeId, layouts })
    }, 400)
  }

  const ensureView = (id: string): WorkspaceView => {
    const existing = views.get(id)
    if (existing) return existing
    const view = createWorkspaceView(panels, { savedLayout: savedLayouts[id], onChange: persist })
    view.element.classList.add('session-instance')
    body.appendChild(view.element)
    views.set(id, view)
    return view
  }

  const disposeView = (id: string): void => {
    const view = views.get(id)
    if (!view) return
    view.dispose()
    view.element.remove()
    views.delete(id)
  }

  // Popover (solo informativo, no captura el ratón): al pasar por una sesión
  // muestra su nombre y los paneles abiertos. Útil sobre todo con la barra
  // lateral plegada (donde solo se ve el número de la sesión).
  const popover = document.createElement('div')
  popover.className = 'session-popover hidden'
  root.appendChild(popover)

  const panelTitlesFor = (id: string): string[] => {
    const view = views.get(id)
    return view ? view.panelTitles() : panelTitlesFromLayout(savedLayouts[id])
  }

  const showPopover = (anchor: HTMLElement, name: string, titles: string[]): void => {
    const items = titles.length
      ? titles.map(t => `<div class="session-popover-item">${t}</div>`).join('')
      : '<div class="session-popover-empty">(vacía)</div>'
    popover.innerHTML = `<div class="session-popover-title">${name}</div>${items}`
    popover.classList.remove('hidden')

    const a = anchor.getBoundingClientRect()
    const p = popover.getBoundingClientRect()
    const pos = getBarPosition()
    const gap = 8
    let left = a.left
    let top = a.bottom + gap
    if (pos === 'left') { left = a.right + gap; top = a.top }
    else if (pos === 'right') { left = a.left - p.width - gap; top = a.top }
    else if (pos === 'bottom') { top = a.top - p.height - gap }
    const clamp = (v: number, max: number) => Math.max(8, Math.min(v, max - 8))
    popover.style.left = `${clamp(left, window.innerWidth - p.width)}px`
    popover.style.top = `${clamp(top, window.innerHeight - p.height)}px`
  }

  const hidePopover = (): void => popover.classList.add('hidden')

  const sessionTab = (
    name: string,
    index: number,
    active: boolean,
    onSelect: () => void,
    onClose: () => void,
    getTitles: () => string[],
  ) => {
    const tab = document.createElement('div')
    tab.className = active ? 'session-tab active' : 'session-tab'

    const badge = document.createElement('span')
    badge.className = 'session-tab-badge'
    badge.textContent = String(index)

    const label = document.createElement('span')
    label.className = 'session-tab-label'
    label.textContent = name

    const close = document.createElement('span')
    close.className = 'session-tab-close'
    close.innerHTML = icon('x')
    close.addEventListener('click', e => { e.stopPropagation(); onClose() })

    tab.append(badge, label, close)
    tab.addEventListener('click', onSelect)
    tab.addEventListener('mouseenter', () => showPopover(tab, name, getTitles()))
    tab.addEventListener('mouseleave', hidePopover)
    return tab
  }

  function render(): void {
    hidePopover()
    tabsArea.innerHTML = ''
    state.sessions.forEach((s, i) => {
      tabsArea.appendChild(
        sessionTab(
          s.name,
          i + 1,
          s.id === state.activeId,
          () => { state = setActiveSession(state, s.id); render() },
          () => closeSession(s.id),
          () => panelTitlesFor(s.id),
        )
      )
    })

    const add = document.createElement('button')
    add.className = 'session-add'
    add.innerHTML = icon('plus')
    add.title = 'Nueva sesión'
    add.addEventListener('click', () => { state = addSession(state); render() })
    tabsArea.appendChild(add)

    views.forEach((view, id) => view.element.classList.toggle('hidden', id !== state.activeId))

    if (state.activeId) {
      const view = ensureView(state.activeId)
      view.element.classList.remove('hidden')
      requestAnimationFrame(() => view.fit())
    }

    persist()
  }

  function closeSession(id: string): void {
    disposeView(id)
    delete savedLayouts[id]
    state = removeSession(state, id)
    render()
  }

  // Comandos para la paleta (Cmd/Ctrl+K), recalculados al abrirla
  const buildCommands = (): Command[] => {
    const active = state.activeId ? views.get(state.activeId) : undefined
    const commands: Command[] = [
      { id: 'new-terminal', label: 'Nueva terminal', keywords: ['terminal', 'shell'], run: () => active?.addPanel('terminal') },
      { id: 'new-tv', label: 'Nuevo panel TV', keywords: ['tv', 'canal'], run: () => active?.addPanel('tv') },
      { id: 'new-session', label: 'Nueva sesión', keywords: ['session', 'espacio'], run: () => { state = addSession(state); render() } },
    ]
    state.sessions.forEach(s => {
      if (s.id !== state.activeId) {
        commands.push({ id: `goto-${s.id}`, label: `Ir a ${s.name}`, keywords: ['sesión'], run: () => { state = setActiveSession(state, s.id); render() } })
      }
    })
    panels.list().filter(d => d.singleton).forEach(d => {
      const on = isUnlocked(d.type)
      commands.push({
        id: `unlock-${d.type}`,
        label: `${on ? '✓' : '○'} Permitir varias ${d.title}`,
        keywords: ['bloquear', 'desbloquear', 'varias', 'multiple', d.type],
        run: () => toggleUnlocked(d.type),
      })
    })
    const barPos = getBarPosition()
    const barOptions: { pos: BarPosition; label: string }[] = [
      { pos: 'top', label: 'arriba' },
      { pos: 'bottom', label: 'abajo' },
      { pos: 'left', label: 'izquierda' },
      { pos: 'right', label: 'derecha' },
    ]
    barOptions.forEach(({ pos, label }) => {
      commands.push({
        id: `bar-${pos}`,
        label: `${barPos === pos ? '✓' : '○'} Sesiones: ${label}`,
        keywords: ['barra', 'sesiones', 'posición', 'mover', label],
        run: () => setBarPosition(pos),
      })
    })
    themeNames.forEach(name => {
      commands.push({ id: `theme-${name}`, label: `Tema: ${themeLabels[name] ?? name}`, keywords: ['theme', 'color'], run: () => setTheme(name) })
    })
    return commands
  }
  root.appendChild(createCommandPalette(buildCommands))

  // Restaurar estado guardado o arrancar con una sesión nueva
  const saved = stateRepo.load()
  if (saved && saved.sessions.length > 0) {
    savedLayouts = saved.layouts
    const activeId = saved.sessions.some(s => s.id === saved.activeId)
      ? saved.activeId
      : saved.sessions[0].id
    state = { sessions: saved.sessions, activeId }
  } else {
    state = addSession(state)
  }
  render()

  return root
}
