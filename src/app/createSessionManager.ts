import type { PanelRegistry } from '../panels/registry'
import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'
import { createWorkspaceView, type WorkspaceView } from './createWorkspaceView'
import { addSession, removeSession, setActiveSession, renameSession, duplicateSession, setSessionProject, type SessionState } from '../core/session/sessionModel'
import { createWindowControls } from '../ui/windowControls'
import { icon } from '../ui/icons'
import { createCommandPalette } from '../ui/commandPalette'
import type { Command } from '../core/command/command'
import { themeNames, themeLabels } from '../core/terminal/themes'
import { setTheme } from '../panels/terminal/themePreference'
import { isMac } from '../ui/platform'
import { invoke } from '@tauri-apps/api/core'
import { getBarPosition, setBarPosition, onBarPositionChange, type BarPosition } from '../ui/sessionBarPreference'
import { panelTitlesFromLayout } from '../core/workspace/panelTitles'
import { loadProfiles } from '../core/terminal/profiles'
import { getDecorations, setDecorations } from '../ui/decorationsPreference'
import { setActiveProjectPath } from '../ui/activeProject'
import { appT, getAppLocale, setAppLocale } from '../core/i18n'
import { parseSavedState } from '../core/session/savedState'

export function createSessionManager(panels: PanelRegistry, stateRepo: WorkspaceStateRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'session-manager'
  root.dataset.ready = 'false'
  root.setAttribute('aria-busy', 'true')

  // macOS: the title bar is an overlay. When the session bar is not at the
  // top, this top strip reserves the space for the traffic lights and lets
  // you drag the window (in CSS it only shows if the bar is not at the top).
  // The bar and the body live in a container whose direction defines the
  // bar's position (top/bottom/left/right).
  const content = document.createElement('div')
  content.className = 'session-content'

  const bar = document.createElement('div')
  bar.className = 'session-bar'

  const tabsArea = document.createElement('div')
  tabsArea.className = 'session-tabs'
  tabsArea.setAttribute('role', 'tablist')
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

  // Debounced saving: layout changes fire in bursts
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const layouts: Record<string, unknown> = { ...savedLayouts }
      views.forEach((view, id) => { layouts[id] = view.serialize() })
      savedLayouts = layouts
      stateRepo.save({ schemaVersion: 1, sessions: state.sessions, activeId: state.activeId, layouts }).catch(error => {
        console.error('Could not persist workspace state', error)
      })
    }, 400)
  }

  const ensureView = (id: string): WorkspaceView => {
    const existing = views.get(id)
    if (existing) return existing
    const view = createWorkspaceView(panels, {
      savedLayout: savedLayouts[id],
      onChange: persist,
      projectPath: () => state.sessions.find(s => s.id === id)?.projectPath,
    })
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

  // Native web-panel webviews paint above the DOM, so suppress them while an
  // overlay (this popover) needs to show on top.
  const setWebOverlay = (on: boolean): void => {
    window.dispatchEvent(new CustomEvent('bento:web-overlay', { detail: on }))
  }

  const showPopover = (anchor: HTMLElement, name: string, titles: string[]): void => {
    popover.replaceChildren()
    const title = document.createElement('div')
    title.className = 'session-popover-title'
    title.textContent = name
    popover.appendChild(title)
    if (titles.length) {
      for (const panelTitle of titles) {
        const item = document.createElement('div')
        item.className = 'session-popover-item'
        item.textContent = panelTitle
        popover.appendChild(item)
      }
    } else {
      const empty = document.createElement('div')
      empty.className = 'session-popover-empty'
      empty.textContent = appT('empty')
      popover.appendChild(empty)
    }
    // Show first so getBoundingClientRect returns real dimensions.
    popover.classList.remove('hidden')
    setWebOverlay(true)

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

  const hidePopover = (): void => { popover.classList.add('hidden'); setWebOverlay(false) }

  const sessionTab = (
    name: string,
    active: boolean,
    onSelect: () => void,
    onClose: () => void,
    onRename: (newName: string) => void,
    onDuplicate: () => void,
    getTitles: () => string[],
  ) => {
    const tab = document.createElement('div')
    tab.className = active ? 'session-tab active' : 'session-tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('tabindex', active ? '0' : '-1')
    tab.setAttribute('aria-selected', String(active))

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

    const duplicate = document.createElement('button')
    duplicate.type = 'button'
    duplicate.className = 'session-tab-duplicate'
    duplicate.title = appT('duplicateSession')
    duplicate.textContent = '⧉'
    duplicate.addEventListener('click', e => { e.stopPropagation(); onDuplicate() })

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'session-tab-close'
    close.title = appT('closeSession')
    close.setAttribute('aria-label', appT('closeSession'))
    close.innerHTML = icon('x')
    close.addEventListener('click', e => { e.stopPropagation(); onClose() })

    const actions = document.createElement('span')
    actions.className = 'session-tab-actions'
    actions.append(duplicate, close)
    tab.append(label, actions)
    tab.addEventListener('click', onSelect)
    tab.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      onSelect()
    })
    tab.addEventListener('mouseenter', () => showPopover(tab, name, getTitles()))
    tab.addEventListener('mouseleave', hidePopover)
    return tab
  }

  function render(): void {
    hidePopover()
    setActiveProjectPath(state.sessions.find(s => s.id === state.activeId)?.projectPath)
    tabsArea.innerHTML = ''
    state.sessions.forEach((s) => {
      tabsArea.appendChild(
        sessionTab(
          s.name,
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
    add.title = appT('newSession')
    add.setAttribute('aria-label', appT('newSession'))
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
      { id: 'new-terminal', label: appT('newTerminal'), keywords: ['terminal', 'shell'], run: () => active?.addPanel('terminal') },
      ...loadProfiles().map(p => ({
        id: `profile-${p.id}`,
        label: `Terminal: ${p.name}`,
        keywords: ['terminal', 'perfil', 'profile', p.shell, p.theme],
        run: () => active?.addPanel('terminal'),
      })),
      { id: 'new-tv', label: appT('newTv'), keywords: ['tv', 'canal'], run: () => active?.addPanel('tv') },
      { id: 'new-web', label: appT('newWeb'), keywords: ['web', 'navegador', 'url'], run: () => active?.addPanel('web') },
      { id: 'new-notes', label: appT('newNotes'), keywords: ['notas', 'notes', 'texto'], run: () => active?.addPanel('notes') },
      { id: 'new-http', label: appT('newHttp'), keywords: ['http', 'api', 'rest', 'postman', 'request'], run: () => active?.addPanel('http') },
      { id: 'new-scripts', label: appT('newScripts'), keywords: ['scripts', 'script', 'comandos', 'sh'], run: () => active?.addPanel('scripts') },
      { id: 'new-db', label: appT('newDb'), keywords: ['db', 'base de datos', 'database', 'mysql', 'mongo', 'docker'], run: () => active?.addPanel('db') },
      { id: 'new-jira', label: appT('newJira'), keywords: ['jira', 'tickets', 'tareas', 'atlassian', 'issues'], run: () => active?.addPanel('jira') },
      { id: 'new-docker', label: appT('newDocker'), keywords: ['docker', 'contenedores', 'containers', 'logs'], run: () => active?.addPanel('docker') },
      { id: 'new-tasks', label: appT('newTasks'), keywords: ['tareas', 'tasks', 'worktree', 'git', 'paralelo'], run: () => active?.addPanel('tasks') },
      { id: 'new-memory', label: appT('newMemory'), keywords: ['memoria', 'memory', 'contexto', 'decisiones', 'resumen'], run: () => active?.addPanel('memory') },
      { id: 'new-diff', label: appT('newDiff'), keywords: ['diff', 'git', 'cambios', 'changes', 'hunk', 'patch'], run: () => active?.addPanel('diff') },
      { id: 'new-review', label: appT('newReview'), keywords: ['review', 'tech review', 'revisar', 'ia', 'ai', 'agente', 'cambios'], run: () => active?.addPanel('review') },
      {
        id: 'bind-project', label: appT('bindProject'),
        keywords: ['proyecto', 'project', 'carpeta', 'cwd', 'directorio'],
        run: () => {
          const cwd = active?.activeCwd()
          if (!state.activeId || !cwd) return
          state = setSessionProject(state, state.activeId, cwd)
          render()
        },
      },
      { id: 'new-session', label: appT('newSession'), keywords: ['session', 'espacio'], run: () => { state = addSession(state); render() } },
      {
        id: 'export-workspace', label: appT('exportWorkspace'), keywords: ['exportar', 'guardar', 'json'],
        run: () => {
          const layouts: Record<string, unknown> = { ...savedLayouts }
          views.forEach((view, id) => { layouts[id] = view.serialize() })
          const data = JSON.stringify({ schemaVersion: 1, sessions: state.sessions, activeId: state.activeId, layouts }, null, 2)
          const a = document.createElement('a')
          a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
          a.download = 'bento-workspace.json'
          a.click()
        },
      },
      {
        id: 'import-workspace', label: appT('importWorkspace'), keywords: ['importar', 'abrir', 'json'],
        run: () => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.json,application/json'
          input.addEventListener('change', () => {
            const file = input.files?.[0]
            if (!file) return
            file.text().then(text => {
              try {
                const parsed = parseSavedState(text)
                if (!parsed) throw new Error(appT('invalidFormat'))
                views.forEach((_, id) => disposeView(id))
                savedLayouts = parsed.layouts
                state = { sessions: parsed.sessions, activeId: parsed.activeId }
                render()
              } catch (e) {
                alert(appT('importError', { error: String(e) }))
              }
            })
          })
          input.click()
        },
      },
    ]
    state.sessions.forEach(s => {
      if (s.id !== state.activeId) {
        commands.push({ id: `goto-${s.id}`, label: appT('goTo', { name: s.name }), keywords: ['sesión'], run: () => { state = setActiveSession(state, s.id); render() } })
      }
    })
const barPos = getBarPosition()
    const barOptions: { pos: BarPosition; label: string }[] = [
      { pos: 'top', label: appT('top') },
      { pos: 'bottom', label: appT('bottom') },
      { pos: 'left', label: appT('left') },
      { pos: 'right', label: appT('right') },
    ]
    barOptions.forEach(({ pos, label }) => {
      commands.push({
        id: `bar-${pos}`,
        label: `${barPos === pos ? '✓' : '○'} ${appT('sessionsPosition', { position: label })}`,
        keywords: ['barra', 'sesiones', 'posición', 'mover', label],
        run: () => setBarPosition(pos),
      })
    })
    themeNames.forEach(name => {
      commands.push({ id: `theme-${name}`, label: appT('theme', { name: themeLabels[name] ?? name }), keywords: ['theme', 'color'], run: () => setTheme(name) })
    })
    const decorated = getDecorations()
    commands.push({
      id: 'toggle-decorations',
      label: `${decorated ? '✓' : '○'} ${appT('windowBorders')}`,
      keywords: ['decoraciones', 'bordes', 'frameless', 'tiling', 'wayland', 'ventana'],
      run: () => {
        const next = !getDecorations()
        setDecorations(next)
        invoke('set_decorations', { enabled: next }).catch(() => {})
      },
    })
    commands.push(
      { id: 'language-es', label: `${getAppLocale() === 'es' ? '✓' : '○'} ${appT('languageSpanish')}`, keywords: ['idioma', 'language', 'español', 'spanish'], run: () => { setAppLocale('es'); location.reload() } },
      { id: 'language-en', label: `${getAppLocale() === 'en' ? '✓' : '○'} ${appT('languageEnglish')}`, keywords: ['idioma', 'language', 'inglés', 'english'], run: () => { setAppLocale('en'); location.reload() } },
    )
    return commands
  }
  invoke('set_decorations', { enabled: getDecorations() }).catch(() => {})

  stateRepo.load().catch(error => {
    console.error('Could not load workspace state', error)
    return null
  }).then(saved => {
    if (saved && saved.sessions.length > 0) {
      savedLayouts = saved.layouts
      const savedActiveExists = saved.sessions.some(s => s.id === saved.activeId)
      const activeId = savedActiveExists ? saved.activeId : saved.sessions[0].id
      state = { sessions: saved.sessions, activeId }
    } else {
      state = addSession(state)
    }
    root.appendChild(createCommandPalette(buildCommands))
    render()
    root.dataset.ready = 'true'
    root.setAttribute('aria-busy', 'false')
  })

  return root
}
