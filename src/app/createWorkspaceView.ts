import { createDockview, type DockviewApi, type AddPanelOptions } from 'dockview-core'
import type { PanelRegistry } from '../panels/registry'
import { lowestAvailableNumber } from '../core/terminal/lowestAvailableNumber'
import { cycleTheme } from '../panels/terminal/themePreference'
import { showContextMenu } from '../ui/contextMenu'

export type SplitDirection = 'within' | 'left' | 'right' | 'above' | 'below'

export interface WorkspaceView {
  element: HTMLElement
  fit: () => void
  isFocused: () => boolean
  serialize: () => object
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

  const addPanel = (type: string, position?: Position): void => {
    const def = panels.get(type)
    if (!def) return
    const n = lowestAvailableNumber(usedNumbers(type))
    api.addPanel({ id: `${type}-${n}`, component: type, title: `${def.title} ${n}`, position })
  }

  const splitFrom = (refId: string, direction: SplitDirection): void =>
    addPanel(typeOf(refId), { referencePanel: refId, direction })

  const addInActiveGroup = (type: string): void =>
    addPanel(type, api.activeGroup ? { referenceGroup: api.activeGroup, direction: 'within' } : undefined)

  api = createDockview(dockHost, {
    createComponent({ id, name }) {
      const def = panels.get(name)
      if (!def) throw new Error(`Panel no registrado: ${name}`)

      const instance = def.create({ panelId: id, removeSelf: () => removePanel(id) })
      fits.add(instance.fit ?? (() => {}))

      // Menú contextual uniforme para cualquier panel: split o nuevo del tipo
      instance.element.addEventListener('contextmenu', e => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, [
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

  api.onDidLayoutChange(() => {
    fitAll()
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

  // Restaurar el layout guardado o, si no hay, crear el inicial (TV + terminal)
  const restored = tryRestore(options.savedLayout)
  if (!restored) {
    addPanel('tv')
    addPanel('terminal', { referencePanel: 'tv-1', direction: 'right' })
  }

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
    dispose: () => {
      window.removeEventListener('keydown', onKeydown)
      api.dispose()
    },
  }
}
