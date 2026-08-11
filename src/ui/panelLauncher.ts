import { icon } from './icons'
import { appT } from '../core/i18n'
import {
  getLauncherPosition, onLauncherPositionChange,
  getLauncherCollapsed, toggleLauncherCollapsed, onLauncherCollapsedChange,
} from './launcherPreference'

// A panel type the launcher can open, with its icon and a label thunk (thunk so
// the label re-reads the active locale, and keeps appT's key typing intact).
interface LauncherEntry {
  type: string
  icon: string
  label: () => string
}

// Ordered agent/dev-first: the tools you reach for most, up top.
const ENTRIES: LauncherEntry[] = [
  { type: 'terminal', icon: 'terminal', label: () => appT('newTerminal') },
  { type: 'tasks',    icon: 'tasks',    label: () => appT('newTasks') },
  { type: 'diff',     icon: 'diff',     label: () => appT('newDiff') },
  { type: 'review',   icon: 'review',   label: () => appT('newReview') },
  { type: 'memory',   icon: 'memory',   label: () => appT('newMemory') },
  { type: 'docker',   icon: 'docker',   label: () => appT('newDocker') },
  { type: 'db',       icon: 'db',       label: () => appT('newDb') },
  { type: 'http',     icon: 'http',     label: () => appT('newHttp') },
  { type: 'jira',     icon: 'jira',     label: () => appT('newJira') },
  { type: 'notes',    icon: 'notes',    label: () => appT('newNotes') },
  { type: 'scripts',  icon: 'scripts',  label: () => appT('newScripts') },
  { type: 'web',      icon: 'web',      label: () => appT('newWeb') },
  { type: 'tv',       icon: 'tv',       label: () => appT('newTv') },
]

// Vertical (left/right) or horizontal (top/bottom) dock of buttons, each opening
// its panel in the active session. Position is driven by launcherPreference.
export function createPanelLauncher(openPanel: (type: string) => void): { element: HTMLElement; setOpenTypes: (open: Set<string>) => void } {
  const element = document.createElement('div')
  element.className = 'panel-launcher'
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', appT('panelLauncher'))

  const buttons = new Map<string, HTMLButtonElement>()

  // Collapse toggle pinned at the start; icons fill and center the rest.
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'panel-launcher-toggle'
  toggle.innerHTML = icon('chevron')

  const icons = document.createElement('div')
  icons.className = 'panel-launcher-icons'
  for (const entry of ENTRIES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'panel-launcher-btn'
    btn.innerHTML = icon(entry.icon)
    const label = entry.label()
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.addEventListener('click', () => openPanel(entry.type))
    buttons.set(entry.type, btn)
    icons.appendChild(btn)
  }

  // Highlight the panel types that already have an open panel in the workspace.
  const setOpenTypes = (open: Set<string>): void => {
    buttons.forEach((btn, type) => btn.classList.toggle('open', open.has(type)))
  }

  element.append(toggle, icons)

  const applyPos = (): void => { element.dataset.pos = getLauncherPosition() }
  const applyCollapsed = (): void => {
    const collapsed = getLauncherCollapsed()
    element.dataset.collapsed = collapsed ? '1' : '0'
    const label = collapsed ? appT('expand') : appT('collapse')
    toggle.title = label
    toggle.setAttribute('aria-label', label)
  }
  applyPos()
  applyCollapsed()
  onLauncherPositionChange(applyPos)
  onLauncherCollapsedChange(applyCollapsed)
  toggle.addEventListener('click', () => toggleLauncherCollapsed())

  return { element, setOpenTypes }
}
