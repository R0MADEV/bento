import { createDockview } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createDefaultLayout } from './core/workspace/layout'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { createTVPanel } from './panels/tv/TVPanel'
import { createTerminalPanel } from './panels/terminal/TerminalPanel'

const app = document.getElementById('app')!
const channelRepo = new IptvOrgChannelRepository()

// Registro de terminales activas para re-ajustarlas ante cambios de layout
const terminalFits = new Set<() => void>()
const fitAllTerminals = () => terminalFits.forEach(fit => fit())

const api = createDockview(app, {
  createComponent({ name }) {
    if (name === 'tv') {
      return { element: createTVPanel(channelRepo), init: () => {} }
    }

    const handle = createTerminalPanel()
    terminalFits.add(handle.fit)
    return {
      element: handle.element,
      init: params => {
        params.api.onDidDimensionsChange(() => handle.fit())
        params.api.onDidVisibilityChange(({ isVisible }) => {
          if (isVisible) handle.fit()
        })
      },
      dispose: () => {
        terminalFits.delete(handle.fit)
        handle.dispose()
        // Tras cerrar, re-ajustar las terminales restantes
        fitAllTerminals()
      },
    }
  },
})

// Cualquier cambio de layout (cierre, split, drag) re-ajusta todas
api.onDidLayoutChange(() => fitAllTerminals())

const layout = createDefaultLayout()
const [left, right] = layout.panels

api.addPanel({ id: left.id, component: left.type, title: left.title })
api.addPanel({
  id: right.id,
  component: right.type,
  title: right.title,
  position: { referencePanel: left.id, direction: 'right' },
})

// Nueva terminal: 'within' = tab, 'right'/'below' = split
type SplitDirection = 'within' | 'right' | 'below'

let terminalCounter = 1

function addTerminal(direction: SplitDirection): void {
  terminalCounter++
  const id = `terminal-${terminalCounter}`
  const reference = api.activePanel ?? api.panels.find(p => p.id.startsWith('terminal-'))

  api.addPanel({
    id,
    component: 'terminal',
    title: `Terminal ${terminalCounter}`,
    position: reference
      ? { referencePanel: reference.id, direction }
      : undefined,
  })
}

window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return

  if (e.key === 't') {
    e.preventDefault()
    addTerminal('within')
  } else if (e.key === 'd' && !e.shiftKey) {
    e.preventDefault()
    addTerminal('right')
  } else if (e.key === 'd' && e.shiftKey) {
    e.preventDefault()
    addTerminal('below')
  }
})
