import { createDockview, type DockviewApi, type AddPanelOptions } from 'dockview-core'
import type { PanelRegistry } from '../panels/registry'
import { lowestAvailableNumber } from '../core/terminal/lowestAvailableNumber'
import { cycleTheme } from '../panels/terminal/themePreference'
import { showContextMenu } from '../ui/contextMenu'
import { furthestEdgeIndex, type MoveDirection } from '../core/workspace/edge'
import { canAddPanel } from '../core/workspace/panelLimit'
import { isUnlocked, setUnlocked, onUnlockChange } from '../panels/panelLockPreference'
import { icon } from '../ui/icons'
import { shortcutLabel } from '../ui/platform'

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

// Un workspace = un Dockview con paneles uniformes (TV, terminal, radio...)
// que se dividen y tabean igual. Splits y "+" operan a este nivel.
export function createWorkspaceView(panels: PanelRegistry, options: WorkspaceOptions = {}): WorkspaceView {
  const element = document.createElement('div')
  // dockview-theme-dark aporta los estilos estructurales; nuestras --dv-*
  // (en .workspace-view) sobreescriben los colores con el tema activo.
  element.className = 'workspace-view dockview-theme-dark'

  // Dockview se monta en un hijo para que no pise las clases del contenedor.
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
        },
        dispose: () => {
          if (instance.fit) fits.delete(instance.fit)
          instance.dispose?.()
          fitAll()
        },
      }
    },
    // "+" en la cabecera: menú con todos los tipos de panel registrados
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

  // Empty state: the workspace starts empty (no panels are auto-opened); show a
  // card to add panels and to unlock multiples of singleton types (e.g. TV).
  const emptyState = document.createElement('div')
  emptyState.className = 'workspace-empty'
  const card = document.createElement('div')
  card.className = 'workspace-empty-card'

  const emptyTitle = document.createElement('div')
  emptyTitle.className = 'workspace-empty-title'
  emptyTitle.textContent = 'Espacio vacío'

  const actions = document.createElement('div')
  actions.className = 'workspace-empty-actions'
  panels.list().forEach(d => {
    const btn = document.createElement('button')
    btn.className = 'workspace-empty-btn'
    btn.innerHTML = `${icon(d.type)}<span>${d.title}</span>`
    btn.addEventListener('click', () => addInActiveGroup(d.type))
    actions.appendChild(btn)
  })

  const hint = document.createElement('div')
  hint.className = 'workspace-empty-hint'
  hint.textContent = `${shortcutLabel('T')} terminal · ${shortcutLabel('K')} acciones`

  card.append(emptyTitle, actions, hint)

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

  // Atajos, solo en el workspace enfocado:
  // Cmd/Ctrl+T nueva terminal · Cmd+D split derecha · Cmd+Shift+D split abajo
  // Cmd/Ctrl+J cambia el tema de la terminal
  const onKeydown = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || !isFocused()) return
    const active = api.activePanel

    if (e.key === 't') {
      e.preventDefault()
      addInActiveGroup('terminal')
    } else if (e.key === 'd' && active) {
      e.preventDefault()
      splitFrom(active.id, e.shiftKey ? 'below' : 'right')
    } else if (e.key === 'j') {
      e.preventDefault()
      cycleTheme()
    }
  }
  window.addEventListener('keydown', onKeydown)

  // Restaurar el layout guardado; si no hay, el workspace queda vacío y se
  // muestra el empty state (el usuario abre los paneles que quiera).
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
      unlockUnsubs.forEach(unsub => unsub())
      api.dispose()
    },
  }
}
