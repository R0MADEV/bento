import type { PanelRegistry } from '../panels/registry'
import { createWorkspaceView, type WorkspaceView } from './createWorkspaceView'
import { addSession, removeSession, setActiveSession, type SessionState } from '../core/session/sessionModel'

// Sesiones que se ocultan entre sí; cada una es un workspace completo.
export function createSessionManager(panels: PanelRegistry): HTMLElement {
  const root = document.createElement('div')
  root.className = 'session-manager'

  const bar = document.createElement('div')
  bar.className = 'session-bar'

  const body = document.createElement('div')
  body.className = 'session-body'

  root.append(bar, body)

  const views = new Map<string, WorkspaceView>()
  let state: SessionState = { sessions: [], activeId: null }

  const ensureView = (id: string): WorkspaceView => {
    const existing = views.get(id)
    if (existing) return existing
    const view = createWorkspaceView(panels)
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

  const sessionTab = (name: string, active: boolean, onSelect: () => void, onClose: () => void) => {
    const tab = document.createElement('div')
    tab.className = active ? 'session-tab active' : 'session-tab'
    const label = document.createElement('span')
    label.textContent = name
    label.addEventListener('click', onSelect)
    const close = document.createElement('span')
    close.className = 'session-tab-close'
    close.textContent = '✕'
    close.addEventListener('click', e => { e.stopPropagation(); onClose() })
    tab.append(label, close)
    return tab
  }

  function render(): void {
    bar.innerHTML = ''
    state.sessions.forEach(s => {
      bar.appendChild(
        sessionTab(
          s.name,
          s.id === state.activeId,
          () => { state = setActiveSession(state, s.id); render() },
          () => closeSession(s.id)
        )
      )
    })

    const add = document.createElement('button')
    add.className = 'session-add'
    add.textContent = '+'
    add.title = 'Nueva sesión'
    add.addEventListener('click', () => { state = addSession(state); render() })
    bar.appendChild(add)

    views.forEach((view, id) => view.element.classList.toggle('hidden', id !== state.activeId))

    if (state.activeId) {
      const view = ensureView(state.activeId)
      view.element.classList.remove('hidden')
      requestAnimationFrame(() => view.fit())
    }
  }

  function closeSession(id: string): void {
    disposeView(id)
    state = removeSession(state, id)
    render()
  }

  state = addSession(state)
  render()

  return root
}
