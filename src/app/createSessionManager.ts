import type { PanelRegistry } from '../panels/registry'
import type { WorkspaceStateRepository } from '../ports/WorkspaceStateRepository'
import { createWorkspaceView, type WorkspaceView } from './createWorkspaceView'
import { createWindowControls } from '../ui/windowControls'
import { createCommandPalette } from '../ui/commandPalette'
import type { Command } from '../core/command/command'
import { themeNames, themeLabels } from '../core/terminal/themes'
import { setTheme } from '../panels/terminal/themePreference'
import { isMac } from '../ui/platform'
import { invoke } from '@tauri-apps/api/core'
import { createPanelLauncher } from '../ui/panelLauncher'
import { createAgentStatusBar } from '../ui/agentStatusBar'
import { createHomeView } from './createHomeView'
import { getLauncherPosition, setLauncherPosition, onLauncherPositionChange, onLauncherCollapsedChange, LAUNCHER_POSITIONS, type LauncherPosition } from '../ui/launcherPreference'
import { loadProfiles } from '../core/terminal/profiles'
import { getDecorations, setDecorations } from '../ui/decorationsPreference'
import { setActiveProjectPath } from '../ui/activeProject'
import { appT, getAppLocale, setAppLocale } from '../core/i18n'

// A single workspace: one panel layout, optionally bound to a project folder.
// (Multi-project work is handled inside it — the Tasks panel is multi-repo.)
export function createSessionManager(panels: PanelRegistry, stateRepo: WorkspaceStateRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'session-manager'
  root.dataset.ready = 'false'
  root.setAttribute('aria-busy', 'true')

  const content = document.createElement('div')
  content.className = 'session-content'

  // Minimal top title bar: the window drag region + (non-mac) window controls,
  // and on macOS reveals the traffic lights on hover (they overlay the corner).
  const bar = document.createElement('div')
  bar.className = 'session-bar'
  if (!isMac) bar.appendChild(createWindowControls())
  if (isMac) {
    invoke('set_traffic_lights_visible', { visible: false }).catch(() => {})
    const showLights = () => invoke('set_traffic_lights_visible', { visible: true }).catch(() => {})
    const hideLights = () => invoke('set_traffic_lights_visible', { visible: false }).catch(() => {})
    bar.addEventListener('mouseenter', showLights)
    bar.addEventListener('mouseleave', hideLights)
  }

  const body = document.createElement('div')
  body.className = 'session-body'
  content.append(bar, body)

  // ── The single workspace ────────────────────────────────────────
  let view: WorkspaceView | undefined
  let projectPath: string | undefined
  let savedLayout: unknown

  const ensureView = (): WorkspaceView => {
    if (view) return view
    view = createWorkspaceView(panels, {
      savedLayout,
      // Closing the last panel returns to the landing → re-check the home too.
      onChange: () => { persist(); updateHomeVisibility() },
      projectPath: () => projectPath,
    })
    view.element.classList.add('session-instance')
    body.appendChild(view.element)
    return view
  }

  const openPanel = (type: string): void => { ensureView().addPanel(type) }
  const launcher = createPanelLauncher(openPanel)
  const agentStatusBar = createAgentStatusBar({ onOpenAgents: () => openPanel('terminal') })

  // Center home, shown only when the workspace has no panels.
  const home = createHomeView({
    onNewSession: () => openPanel('tasks'),
    onResumeAgents: () => openPanel('terminal'),
    onOpenProject: (cwd) => {
      projectPath = cwd
      setActiveProjectPath(projectPath)
      openPanel('terminal')
    },
  })
  body.appendChild(home.element)

  const shell = document.createElement('div')
  shell.className = 'session-shell'
  shell.append(launcher.element, content)
  root.append(shell, agentStatusBar.element)

  const refit = (): void => { requestAnimationFrame(() => view?.fit()) }
  const applyLauncherPosition = (): void => { root.dataset.launcherPos = getLauncherPosition() }
  applyLauncherPosition()
  onLauncherPositionChange(() => { applyLauncherPosition(); refit() })
  onLauncherCollapsedChange(refit)

  // Debounced saving: layout changes fire in bursts.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      stateRepo.save({ schemaVersion: 2, projectPath, layout: view?.serialize() }).catch(error => {
        console.error('Could not persist workspace state', error)
      })
    }, 400)
  }

  // The home shows when there is nothing to work on (no panels). The launcher is
  // chrome for working, so it hides whenever the home shows.
  const updateHomeVisibility = (): void => {
    const empty = !view || view.panelTitles().length === 0
    home.element.classList.toggle('hidden', !empty)
    launcher.element.classList.toggle('hidden', empty)
    if (view) view.element.classList.toggle('hidden', empty)
    if (empty) home.refresh()
  }

  const render = (): void => {
    setActiveProjectPath(projectPath)
    if (view) { view.element.classList.remove('hidden'); refit() }
    updateHomeVisibility()
    persist()
  }

  const buildCommands = (): Command[] => {
    const commands: Command[] = [
      { id: 'new-terminal', label: appT('newTerminal'), keywords: ['terminal', 'shell'], run: () => ensureView().addPanel('terminal') },
      ...loadProfiles().map(p => ({
        id: `profile-${p.id}`,
        label: `Terminal: ${p.name}`,
        keywords: ['terminal', 'perfil', 'profile', p.shell, p.theme],
        run: () => ensureView().addPanel('terminal'),
      })),
      { id: 'new-tv', label: appT('newTv'), keywords: ['tv', 'canal'], run: () => ensureView().addPanel('tv') },
      { id: 'new-web', label: appT('newWeb'), keywords: ['web', 'navegador', 'url'], run: () => ensureView().addPanel('web') },
      { id: 'new-notes', label: appT('newNotes'), keywords: ['notas', 'notes', 'texto'], run: () => ensureView().addPanel('notes') },
      { id: 'new-http', label: appT('newHttp'), keywords: ['http', 'api', 'rest', 'postman', 'request'], run: () => ensureView().addPanel('http') },
      { id: 'new-scripts', label: appT('newScripts'), keywords: ['scripts', 'script', 'comandos', 'sh'], run: () => ensureView().addPanel('scripts') },
      { id: 'new-db', label: appT('newDb'), keywords: ['db', 'base de datos', 'database', 'mysql', 'mongo', 'docker'], run: () => ensureView().addPanel('db') },
      { id: 'new-jira', label: appT('newJira'), keywords: ['jira', 'tickets', 'tareas', 'atlassian', 'issues'], run: () => ensureView().addPanel('jira') },
      { id: 'new-docker', label: appT('newDocker'), keywords: ['docker', 'contenedores', 'containers', 'logs'], run: () => ensureView().addPanel('docker') },
      { id: 'new-tasks', label: appT('newTasks'), keywords: ['tareas', 'tasks', 'worktree', 'git', 'paralelo'], run: () => ensureView().addPanel('tasks') },
      { id: 'new-memory', label: appT('newMemory'), keywords: ['memoria', 'memory', 'contexto', 'decisiones', 'resumen'], run: () => ensureView().addPanel('memory') },
      { id: 'new-diff', label: appT('newDiff'), keywords: ['diff', 'git', 'cambios', 'changes', 'hunk', 'patch'], run: () => ensureView().addPanel('diff') },
      { id: 'new-review', label: appT('newReview'), keywords: ['review', 'tech review', 'revisar', 'ia', 'ai', 'agente', 'cambios'], run: () => ensureView().addPanel('review') },
      {
        id: 'bind-project', label: appT('bindProject'),
        keywords: ['proyecto', 'project', 'carpeta', 'cwd', 'directorio'],
        run: () => {
          const cwd = view?.activeCwd()
          if (!cwd) return
          projectPath = cwd
          setActiveProjectPath(projectPath)
          render()
        },
      },
    ]
    const launcherPos = getLauncherPosition()
    const launcherLabels: Record<LauncherPosition, string> = {
      left: appT('left'), right: appT('right'), top: appT('top'), bottom: appT('bottom'),
    }
    LAUNCHER_POSITIONS.forEach(pos => {
      commands.push({
        id: `launcher-${pos}`,
        label: `${launcherPos === pos ? '✓' : '○'} ${appT('launcherPosition', { position: launcherLabels[pos] })}`,
        keywords: ['launcher', 'paneles', 'dock', 'posición', 'mover', launcherLabels[pos]],
        run: () => setLauncherPosition(pos),
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
    if (saved) {
      savedLayout = saved.layout
      projectPath = saved.projectPath
      setActiveProjectPath(projectPath)
      if (savedLayout !== undefined) ensureView()
    }
    root.appendChild(createCommandPalette(buildCommands))
    render()
    root.dataset.ready = 'true'
    root.setAttribute('aria-busy', 'false')
  })

  return root
}
