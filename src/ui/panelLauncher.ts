import { icon } from './helpers/icons'
import { appT } from '../core/i18n'

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
  { type: 'docker',   icon: 'docker',   label: () => appT('newDocker') },
  { type: 'db',       icon: 'db',       label: () => appT('newDb') },
  { type: 'http',     icon: 'http',     label: () => appT('newHttp') },
  { type: 'jira',     icon: 'jira',     label: () => appT('newJira') },
  { type: 'notes',    icon: 'notes',    label: () => appT('newNotes') },
  { type: 'scripts',  icon: 'scripts',  label: () => appT('newScripts') },
  { type: 'web',      icon: 'web',      label: () => appT('newWeb') },
  { type: 'tv',       icon: 'tv',       label: () => appT('newTv') },
  { type: 'remote',   icon: 'phone',    label: () => appT('newRemote') },
]

// A horizontal toolbar of panel icons. It lives inside the top title strip
// (revealed on hover), so it costs no persistent space. Each button opens — or
// focuses, if already open — its panel in the workspace.
export function createPanelLauncher(openPanel: (type: string) => void): { element: HTMLElement; setOpenTypes: (open: Set<string>) => void } {
  const element = document.createElement('div')
  element.className = 'panel-launcher'
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', appT('panelLauncher'))

  const buttons = new Map<string, HTMLButtonElement>()

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

  element.appendChild(icons)
  return { element, setOpenTypes }
}
