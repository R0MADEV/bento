import { createDockview, type DockviewApi, type AddPanelOptions } from 'dockview-core'
import type { PanelRegistry } from '../panels/registry'
import { lowestAvailableNumber } from '../core/terminal/lowestAvailableNumber'
import { cycleTheme } from '../panels/terminal/themePreference'
import { showContextMenu } from '../ui/contextMenu'
import { furthestEdgeIndex, type MoveDirection } from '../core/workspace/edge'
import { canAddPanel } from '../core/workspace/panelLimit'
import { isUnlocked, setUnlocked, onUnlockChange } from '../panels/panelLockPreference'
import { icon } from '../ui/icons'
import { isMac, shortcutLabel } from '../ui/platform'
import { currentPanelIndex } from '../core/workspace/currentPanel'

export type SplitDirection = 'within' | 'left' | 'right' | 'above' | 'below'

export interface WorkspaceView {
  element: HTMLElement
  fit: () => void
  isFocused: () => boolean
  serialize: () => object
  panelTitles: () => string[]
  addPanel: (type: string) => void
  dispose: () => void
}

export interface WorkspaceOptions {
  savedLayout?: unknown
  onChange?: () => void
}

export function createWorkspaceView(panels: PanelRegistry, options: WorkspaceOptions = {}): WorkspaceView {
  const element = document.createElement('div')
  // dockview-theme-dark aporta los estilos estructurales; nuestras --dv-*
  // (en .workspace-view) sobreescriben los colores con el tema activo.
  element.className = 'workspace-view dockview-theme-dark'

  const dockHost = document.createElement('div')
  dockHost.className = 'dv-host'
  element.appendChild(dockHost)

  const fits = new Set<() => void>()
  const fitAll = () => fits.forEach(f => f())

  let api: DockviewApi

  const typeOf = (panelId: string): string => panelId.slice(0, panelId.lastIndexOf('-'))

  const usedNumbers = (type: string): number[] => {
    const prefix = `${type}-`
    return api.panels
      .filter(p => p.id.startsWith(prefix))
      .map(p => Number(p.id.slice(prefix.length)))
      .filter(Number.isInteger)
  }

  type Position = AddPanelOptions['position']

  const existingOfType = (type: string) => api.panels.find(p => typeOf(p.id) === type)

  // Mapa panel id → instancia, para poder llamar focus() tras ciclar paneles
  const instanceMap = new Map<string, import('../panels/registry').PanelInstance>()

  const addPanel = (type: string, position?: Position): void => {
    const def = panels.get(type)
    if (!def) return
    const allowed = canAddPanel({
      singleton: !!def.singleton,
      unlocked: isUnlocked(type),
      alreadyExists: !!existingOfType(type),
    })
    // Blocked singleton (e.g. a 2nd TV while locked): focus the existing one.
    if (!allowed) {
      existingOfType(type)?.api.setActive()
      return
    }
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

  api = createDockview(dockHost, {
    createComponent({ id, name }) {
      const def = panels.get(name)
      if (!def) throw new Error(`Panel no registrado: ${name}`)

      const instance = def.create({ panelId: id, removeSelf: () => removePanel(id) })
      instanceMap.set(id, instance)
      fits.add(instance.fit ?? (() => {}))

      // Context menu: split, move (HTML5 drag doesn't work in WKWebView)
      instance.element.addEventListener('contextmenu', e => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, [
          { label: '↦ Mover a la derecha', onClick: () => movePanel(id, 'right') },
          { label: '↤ Mover a la izquierda', onClick: () => movePanel(id, 'left') },
          { label: '↥ Mover arriba', onClick: () => movePanel(id, 'above') },
          { label: '↧ Mover abajo', onClick: () => movePanel(id, 'below') },
          { label: 'Dividir derecha', onClick: () => splitFrom(id, 'right') },
          { label: 'Dividir izquierda', onClick: () => splitFrom(id, 'left') },
          { label: 'Dividir arriba', onClick: () => splitFrom(id, 'above') },
          { label: 'Dividir abajo', onClick: () => splitFrom(id, 'below') },
          { label: `Nueva pestaña (${def.title})`, onClick: () => splitFrom(id, 'within') },
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
      btn.title = 'Añadir panel'
      const onClick = () => {
        const rect = btn.getBoundingClientRect()
        showContextMenu(rect.left, rect.bottom, panels.list().map(d => ({
          label: d.title,
          onClick: () => addInActiveGroup(d.type),
        })))
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
  emptyTitle.textContent = 'Espacio vacío'

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
    btn.innerHTML = `${icon(d.type)}<span>${d.title}</span>`
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

  // One checkbox per singleton type to allow multiple instances.
  const unlockUnsubs: Array<() => void> = []
  panels.list().filter(d => d.singleton).forEach(d => {
    const label = document.createElement('label')
    label.className = 'workspace-empty-option'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = isUnlocked(d.type)
    cb.addEventListener('change', () => setUnlocked(d.type, cb.checked))
    unlockUnsubs.push(onUnlockChange(() => { cb.checked = isUnlocked(d.type) }))
    const span = document.createElement('span')
    span.textContent = `Permitir varias ${d.title}`
    label.append(cb, span)
    card.appendChild(label)
  })

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

  // Ctrl+Tab desde terminales (xterm intercepta el keydown y lo re-despacha)
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
    addPanel: type => addInActiveGroup(type),
    dispose: () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keydown', onCyclePanelKeydown)
      window.removeEventListener('bento:cycle-panel', onCyclePanel)
      unlockUnsubs.forEach(unsub => unsub())
      api.dispose()
    },
  }
}
