import type { PanelRegistry } from '../panels/registry'
import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'
import { createWorkspaceView, type WorkspaceView } from './createWorkspaceView'
import { addSession, removeSession, setActiveSession, renameSession, duplicateSession, type SessionState } from '../core/session/sessionModel'
import { createWindowControls } from '../ui/windowControls'
import { icon } from '../ui/icons'
import { createCommandPalette } from '../ui/commandPalette'
import type { Command } from '../core/command/command'
import { themeNames, themeLabels } from '../core/terminal/themes'
import { setTheme } from '../panels/terminal/themePreference'
import { isUnlocked, toggleUnlocked } from '../panels/panelLockPreference'
import { isMac } from '../ui/platform'
import { invoke } from '@tauri-apps/api/core'
import { getBarPosition, setBarPosition, onBarPositionChange, type BarPosition } from '../ui/sessionBarPreference'
import { panelTitlesFromLayout } from '../core/workspace/panelTitles'
import { loadProfiles } from '../core/terminal/profiles'
import { getDecorations, setDecorations } from '../ui/decorationsPreference'

export function createSessionManager(panels: PanelRegistry, stateRepo: WorkspaceStateRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'session-manager'

  // macOS: la barra de título es overlay. Cuando la barra de sesiones no está
  // arriba, esta franja superior reserva el hueco de los semáforos y permite
  // arrastrar la ventana (en CSS solo se muestra si la barra no está arriba).
  // La barra y el cuerpo viven en un contenedor cuya dirección define la
  // posición de la barra (arriba/abajo/izquierda/derecha).
  const content = document.createElement('div')
  content.className = 'session-content'

  const bar = document.createElement('div')
  bar.className = 'session-bar'

  const tabsArea = document.createElement('div')
  tabsArea.className = 'session-tabs'
  bar.appendChild(tabsArea)

  if (!isMac) bar.appendChild(createWindowControls())

  if (isMac) {
    // Strip above the session content: invisible hover zone (4px) that reveals
    // the traffic lights when the bar is NOT at the top.
    // When the bar IS at top, CSS hides this strip and the bar itself is the
    // title bar — hovering the bar shows the traffic lights instead.
    const macStrip = document.createElement('div')
    macStrip.className = 'mac-title-strip'
    root.appendChild(macStrip)

    invoke('set_traffic_lights_visible', { visible: false }).catch(() => {})

    const showLights = () => invoke('set_traffic_lights_visible', { visible: true }).catch(() => {})
    const hideLights = () => invoke('set_traffic_lights_visible', { visible: false }).catch(() => {})

    macStrip.addEventListener('mouseenter', showLights)
    macStrip.addEventListener('mouseleave', hideLights)

    bar.addEventListener('mouseenter', () => { if (getBarPosition() === 'top') showLights() })
    bar.addEventListener('mouseleave', () => { if (getBarPosition() === 'top') hideLights() })
  }

  const body = document.createElement('div')
  body.className = 'session-body'

  content.append(bar, body)
  root.appendChild(content)

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
    // Show first so getBoundingClientRect returns real dimensions.
    popover.classList.remove('hidden')

    const a = anchor.getBoundingClientRect()
    const p = popover.getBoundingClientRect()
    const pos = getBarPosition()
    const gap = 8
    let left = a.left
    let top = a.bottom + gap
    if (pos === 'left')   { left = a.right + gap;          top = a.top }
    if (pos === 'right')  { left = a.left - p.width - gap; top = a.top }
    if (pos === 'bottom') { top = a.top - p.height - gap }
    const clampX = (v: number) => Math.max(8, Math.min(v, window.innerWidth  - p.width  - 8))
    const clampY = (v: number) => Math.max(8, Math.min(v, window.innerHeight - p.height - 8))
    popover.style.left = `${clampX(left)}px`
    popover.style.top  = `${clampY(top)}px`
  }

  const hidePopover = (): void => popover.classList.add('hidden')

  const sessionTab = (
    name: string,
    index: number,
    active: boolean,
    onSelect: () => void,
    onClose: () => void,
    onRename: (newName: string) => void,
    onDuplicate: () => void,
    getTitles: () => string[],
  ) => {
    const tab = document.createElement('div')
    tab.className = active ? 'session-tab active' : 'session-tab'

    const label = document.createElement('span')
    label.className = 'session-tab-label'
    label.textContent = name

    label.addEventListener('dblclick', e => {
      e.stopPropagation()
      hidePopover()
      const input = document.createElement('input')
      input.className = 'session-tab-rename'
      input.value = name
      label.replaceWith(input)
      input.select()
      input.focus()
      const save = () => {
        const next = input.value.trim() || name
        onRename(next)
      }
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur() }
        if (e.key === 'Escape') { input.value = name; input.blur() }
        e.stopPropagation()
      })
      input.addEventListener('blur', save)
    })

    const duplicate = document.createElement('span')
    duplicate.className = 'session-tab-duplicate'
    duplicate.title = 'Duplicar sesión'
    duplicate.textContent = '⧉'
    duplicate.addEventListener('click', e => { e.stopPropagation(); onDuplicate() })

    const close = document.createElement('span')
    close.className = 'session-tab-close'
    close.innerHTML = icon('x')
    close.addEventListener('click', e => { e.stopPropagation(); onClose() })

    const actions = document.createElement('span')
    actions.className = 'session-tab-actions'
    actions.append(duplicate, close)
    tab.append(label, actions)
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
          () => { const next = setActiveSession(state, s.id); if (next.activeId !== state.activeId) { state = next; render() } },
          () => closeSession(s.id),
          (newName) => { state = renameSession(state, s.id, newName); render() },
          () => {
            const layout = views.get(s.id)?.serialize() ?? savedLayouts[s.id]
            state = duplicateSession(state, s.id)
            const newId = state.activeId!
            if (layout) savedLayouts[newId] = layout
            render()
          },
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

  const buildCommands = (): Command[] => {
    const active = state.activeId ? views.get(state.activeId) : undefined
    const commands: Command[] = [
      { id: 'new-terminal', label: 'Nueva terminal', keywords: ['terminal', 'shell'], run: () => active?.addPanel('terminal') },
      ...loadProfiles().map(p => ({
        id: `profile-${p.id}`,
        label: `Terminal: ${p.name}`,
        keywords: ['terminal', 'perfil', 'profile', p.shell, p.theme],
        run: () => active?.addPanel('terminal'),
      })),
      { id: 'new-tv', label: 'Nuevo panel TV', keywords: ['tv', 'canal'], run: () => active?.addPanel('tv') },
      { id: 'new-session', label: 'Nueva sesión', keywords: ['session', 'espacio'], run: () => { state = addSession(state); render() } },
      {
        id: 'export-workspace', label: 'Exportar workspace', keywords: ['exportar', 'guardar', 'json'],
        run: () => {
          const layouts: Record<string, unknown> = { ...savedLayouts }
          views.forEach((view, id) => { layouts[id] = view.serialize() })
          const data = JSON.stringify({ sessions: state.sessions, activeId: state.activeId, layouts }, null, 2)
          const a = document.createElement('a')
          a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
          a.download = 'bento-workspace.json'
          a.click()
        },
      },
      {
        id: 'import-workspace', label: 'Importar workspace', keywords: ['importar', 'abrir', 'json'],
        run: () => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.json,application/json'
          input.addEventListener('change', () => {
            const file = input.files?.[0]
            if (!file) return
            file.text().then(text => {
              try {
                const parsed = JSON.parse(text)
                if (!Array.isArray(parsed.sessions)) throw new Error('Formato inválido')
                views.forEach((_, id) => disposeView(id))
                savedLayouts = parsed.layouts ?? {}
                state = { sessions: parsed.sessions, activeId: parsed.activeId }
                render()
              } catch (e) {
                alert(`Error al importar: ${e}`)
              }
            })
          })
          input.click()
        },
      },
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
    const decorated = getDecorations()
    commands.push({
      id: 'toggle-decorations',
      label: `${decorated ? '✓' : '○'} Bordes de ventana`,
      keywords: ['decoraciones', 'bordes', 'frameless', 'tiling', 'wayland', 'ventana'],
      run: () => {
        const next = !getDecorations()
        setDecorations(next)
        invoke('set_decorations', { enabled: next }).catch(() => {})
      },
    })
    return commands
  }
  root.appendChild(createCommandPalette(buildCommands))

  invoke('set_decorations', { enabled: getDecorations() }).catch(() => {})

  const saved = stateRepo.load()
  if (saved && saved.sessions.length > 0) {
    savedLayouts = saved.layouts
    const savedActiveExists = saved.sessions.some(s => s.id === saved.activeId)
    const activeId = savedActiveExists ? saved.activeId : saved.sessions[0].id
    state = { sessions: saved.sessions, activeId }
  } else {
    state = addSession(state)
  }
  render()

  return root
}
