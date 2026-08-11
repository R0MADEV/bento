import { createDockview, type DockviewApi, type AddPanelOptions } from 'dockview-core'
import type { PanelRegistry } from '../panels/registry'
import { lowestAvailableNumber } from '../core/terminal/lowestAvailableNumber'
import { cycleTheme } from '../panels/terminal/themePreference'
import { showContextMenu } from '../ui/contextMenu'
import { furthestEdgeIndex, type MoveDirection } from '../core/workspace/edge'
import { icon } from '../ui/icons'
import { isMac, shortcutLabel } from '../ui/platform'
import { currentPanelIndex } from '../core/workspace/currentPanel'
import { appT } from '../core/i18n'

export type SplitDirection = 'within' | 'left' | 'right' | 'above' | 'below'

export interface WorkspaceView {
  element: HTMLElement
  fit: () => void
  isFocused: () => boolean
  serialize: () => object
  panelTitles: () => string[]
  panelTypes: () => string[]
  addPanel: (type: string) => void
  focusOrAddPanel: (type: string) => void
  activeCwd: () => string | undefined
  dispose: () => void
}

export interface WorkspaceOptions {
  savedLayout?: unknown
  onChange?: () => void
  // The session's project folder, read when each panel is created.
  projectPath?: () => string | undefined
}

export function createWorkspaceView(panels: PanelRegistry, options: WorkspaceOptions = {}): WorkspaceView {
  const element = document.createElement('div')
  // dockview-theme-dark provides the structural styles; our --dv-*
  // (in .workspace-view) override the colors with the active theme.
  element.className = 'workspace-view dockview-theme-dark'

  const dockHost = document.createElement('div')
  dockHost.className = 'dv-host'
  element.appendChild(dockHost)

  const fits = new Set<() => void>()
  const fitAll = () => fits.forEach(f => f())

  const typeOf = (panelId: string): string => panelId.slice(0, panelId.lastIndexOf('-'))

  const usedNumbers = (type: string): number[] => {
    const prefix = `${type}-`
    return api.panels
      .filter(p => p.id.startsWith(prefix))
      .map(p => Number(p.id.slice(prefix.length)))
      .filter(Number.isInteger)
  }

  type Position = AddPanelOptions['position']

  // Map of panel id → instance, so focus() can be called after cycling panels
  const instanceMap = new Map<string, import('../panels/registry').PanelInstance>()

  const addPanel = (type: string, position?: Position): void => {
    const def = panels.get(type)
    if (!def) return
    const n = lowestAvailableNumber(usedNumbers(type))
    api.addPanel({ id: `${type}-${n}`, component: type, title: `${def.title} ${n}`, position })
  }

  const splitFrom = (refId: string, direction: SplitDirection): void =>
    addPanel(typeOf(refId), { referencePanel: refId, direction })

  // Move a panel to the edge of the layout (alternative to dragging, which the
  // macOS WebView doesn't support for HTML5 drag-and-drop). moveTo needs a
  // target group: we pick the group at the requested edge (pure logic in core/edge).
  const edgeOf = { right: 'right', left: 'left', above: 'top', below: 'bottom' } as const
  const movePanel = (id: string, direction: MoveDirection): void => {
    const panel = api.getPanel(id)
    if (!panel) return
    const groups = api.groups
    const i = furthestEdgeIndex(groups.map(g => g.element.getBoundingClientRect()), direction)
    const target = groups[i]
    const movingIntoOwnLoneGroup = target === panel.group && target.panels.length === 1
    if (movingIntoOwnLoneGroup) return
    panel.api.moveTo({ group: target, position: edgeOf[direction] })
  }

  const addInActiveGroup = (type: string): void =>
    addPanel(type, api.activeGroup ? { referenceGroup: api.activeGroup, direction: 'within' } : undefined)

  // Launcher-driven navigation (tabs are hidden): focus the panel of this type if
  // one is already open, otherwise create it.
  const focusOrAddPanel = (type: string): void => {
    const existing = api.panels.find(p => typeOf(p.id) === type)
    if (!existing) { addInActiveGroup(type); return }
    existing.api.setActive()
    requestAnimationFrame(() => instanceMap.get(existing.id)?.focus?.())
  }

  const api: DockviewApi = createDockview(dockHost, {
    createComponent({ id, name }) {
      const def = panels.get(name)
      if (!def) throw new Error(appT('panelNotRegistered', { name }))

      const instance = def.create({ panelId: id, removeSelf: () => removePanel(id), projectPath: options.projectPath?.() })
      instanceMap.set(id, instance)
      fits.add(instance.fit ?? (() => {}))

      // Context menu: split, move (HTML5 drag doesn't work in WKWebView)
      instance.element.addEventListener('contextmenu', e => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, [
          { label: appT('closePanel'), onClick: () => removePanel(id) },
          { label: appT('moveRight'), onClick: () => movePanel(id, 'right') },
          { label: appT('moveLeft'), onClick: () => movePanel(id, 'left') },
          { label: appT('moveUp'), onClick: () => movePanel(id, 'above') },
          { label: appT('moveDown'), onClick: () => movePanel(id, 'below') },
          { label: appT('splitRight'), onClick: () => splitFrom(id, 'right') },
          { label: appT('splitLeft'), onClick: () => splitFrom(id, 'left') },
          { label: appT('splitUp'), onClick: () => splitFrom(id, 'above') },
          { label: appT('splitDown'), onClick: () => splitFrom(id, 'below') },
          { label: appT('newTab', { name: def.title }), onClick: () => splitFrom(id, 'within') },
        ])
      })

      return {
        element: instance.element,
        init: params => {
          if (instance.fit) {
            params.api.onDidDimensionsChange(() => instance.fit!())
            params.api.onDidVisibilityChange(({ isVisible }) => { if (isVisible) instance.fit!() })
          }
          instance.onTitleChange?.(title => params.api.setTitle(title))
          instance.onReady?.({
            maximize: () => params.api.maximize(),
            exitMaximized: () => params.api.exitMaximized(),
            isMaximized: () => params.api.isMaximized(),
          })
        },
        dispose: () => {
          if (instance.fit) fits.delete(instance.fit)
          instanceMap.delete(id)
          instance.dispose?.()
          fitAll()
        },
      }
    },
    createRightHeaderActionComponent: () => {
      const btn = document.createElement('button')
      btn.className = 'group-add-tab'
      btn.textContent = '+'
      btn.title = appT('addPanel')
      const onClick = () => {
        const rect = btn.getBoundingClientRect()
        showContextMenu(rect.right, rect.bottom, panels.list().map(d => ({
          label: d.title,
          onClick: () => addInActiveGroup(d.type),
        })), { align: 'right' })
      }
      btn.addEventListener('click', onClick)
      return { element: btn, init: () => {}, dispose: () => btn.removeEventListener('click', onClick) }
    },
  })

  function removePanel(id: string): void {
    const panel = api.getPanel(id)
    if (panel) api.removePanel(panel)
  }

  const emptyState = document.createElement('div')
  emptyState.className = 'workspace-empty'
  const card = document.createElement('div')
  card.className = 'workspace-empty-card'

  const emptyTitle = document.createElement('div')
  emptyTitle.className = 'workspace-empty-title'
  emptyTitle.textContent = appT('emptyWorkspace')

  const mod = isMac ? '⌘' : 'Ctrl'

  const panelHints: Record<string, [string, string][]> = {
    terminal: [
      [shortcutLabel('T'), 'Nueva terminal'],
      [shortcutLabel('D'), 'Split derecha'],
      [isMac ? '⌘⇧D' : 'Ctrl+Shift+D', 'Split abajo'],
      [shortcutLabel('F'), 'Buscar'],
      [shortcutLabel('J'), 'Cambiar tema'],
      ['Ctrl+Tab', 'Panel siguiente'],
    [`${mod}+scroll`, 'Zoom'],
    ],
    tv: [
      ['Click', 'Abrir TV'],
      [shortcutLabel('K'), 'Buscar canal'],
    ],
  }

  const hintsEl = document.createElement('div')
  hintsEl.className = 'workspace-empty-hints hidden'

  const actions = document.createElement('div')
  actions.className = 'workspace-empty-actions'
  panels.list().forEach(d => {
    const btn = document.createElement('button')
    btn.className = 'workspace-empty-btn'
    const iconSlot = document.createElement('span')
    iconSlot.innerHTML = icon(d.type)
    const label = document.createElement('span')
    label.textContent = d.title
    btn.append(iconSlot, label)
    btn.addEventListener('click', () => addInActiveGroup(d.type))

    const hints = panelHints[d.type] ?? []
    btn.addEventListener('mouseenter', () => {
      hintsEl.innerHTML = ''
      hints.forEach(([key, label]) => {
        const kbd = document.createElement('kbd')
        kbd.textContent = key
        const desc = document.createElement('span')
        desc.textContent = label
        hintsEl.append(kbd, desc)
      })
      hintsEl.classList.remove('hidden')
    })
    btn.addEventListener('mouseleave', () => hintsEl.classList.add('hidden'))

    actions.appendChild(btn)
  })

  card.append(emptyTitle, actions, hintsEl)

  emptyState.appendChild(card)
  element.appendChild(emptyState)

  const updateEmpty = (): void => { emptyState.classList.toggle('hidden', api.panels.length > 0) }

  api.onDidLayoutChange(() => {
    fitAll()
    updateEmpty()
    options.onChange?.()
  })

  const isFocused = (): boolean => element.contains(document.activeElement)

  const onKeydown = (e: KeyboardEvent): void => {
    if (!isFocused()) return
    const mod = e.metaKey || e.ctrlKey
    const active = api.activePanel

    if (!mod) return

    if (e.key === 't') {
      e.preventDefault()
      addInActiveGroup('terminal')
    } else if (e.key === 'd' && active) {
      e.preventDefault()
      splitFrom(active.id, e.shiftKey ? 'below' : 'right')
    } else if (e.key === 'j') {
      // The focused terminal cycles its local theme; outside it, the global one.
      const inTerminal = active ? typeOf(active.id) === 'terminal' : false
      if (inTerminal) return
      e.preventDefault()
      cycleTheme()
    }
  }
  window.addEventListener('keydown', onKeydown)

  const cyclePanel = (reverse: boolean) => {
    const all = api.panels
    if (all.length < 2) return
    const idx = currentPanelIndex(
      all,
      document.activeElement,
      id => instanceMap.get(id)?.element,
      api.activePanel?.id ?? null,
    )
    const next = all[(idx + (reverse ? -1 : 1) + all.length) % all.length]
    next.api.setActive()
    requestAnimationFrame(() => instanceMap.get(next.id)?.focus?.())
  }

  // Ctrl+Tab from terminals (xterm intercepts the keydown and re-dispatches it)
  const onCyclePanel = (e: Event) => {
    if (!isFocused()) return
    cyclePanel((e as CustomEvent<{ reverse: boolean }>).detail.reverse)
  }
  window.addEventListener('bento:cycle-panel', onCyclePanel)

  const onCyclePanelKeydown = (e: KeyboardEvent) => {
    const isCycleShortcut = e.ctrlKey && e.key === 'Tab' && isFocused()
    if (!isCycleShortcut) return
    e.preventDefault()
    cyclePanel(e.shiftKey)
  }
  window.addEventListener('keydown', onCyclePanelKeydown)

  dockHost.addEventListener('dblclick', e => {
    const tabContent = (e.target as HTMLElement).closest<HTMLElement>('.dv-default-tab-content')
    if (!tabContent) return
    const title = tabContent.textContent?.trim() ?? ''
    const panel = api.panels.find(p => p.title === title)
    if (!panel) return

    const input = document.createElement('input')
    input.className = 'dv-tab-rename'
    input.value = title
    tabContent.textContent = ''
    tabContent.appendChild(input)
    input.select()
    input.focus()

    const save = () => {
      const next = input.value.trim() || title
      panel.api.setTitle(next)
    }
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur() }
      if (e.key === 'Escape') { input.value = title; input.blur() }
      e.stopPropagation()
    })
    input.addEventListener('blur', save)
  })

  tryRestore(options.savedLayout)
  updateEmpty()

  function tryRestore(layout: unknown): boolean {
    if (!layout || typeof layout !== 'object') return false
    try {
      api.fromJSON(layout as Parameters<typeof api.fromJSON>[0])
      return api.panels.length > 0
    } catch {
      return false
    }
  }

  return {
    element,
    fit: fitAll,
    isFocused,
    serialize: () => api.toJSON(),
    panelTitles: () => api.panels.map(p => p.title ?? p.id),
    panelTypes: () => [...new Set(api.panels.map(p => typeOf(p.id)))],
    addPanel: type => addInActiveGroup(type),
    focusOrAddPanel,
    activeCwd: () => (api.activePanel ? instanceMap.get(api.activePanel.id)?.getCwd?.() : undefined),
    dispose: () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keydown', onCyclePanelKeydown)
      window.removeEventListener('bento:cycle-panel', onCyclePanel)
      api.dispose()
    },
  }
}
