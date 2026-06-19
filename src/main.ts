import { createDockview } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createDefaultLayout } from './core/workspace/layout'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { createTVPanel } from './panels/tv/TVPanel'
import { createTerminalPanel } from './panels/terminal/TerminalPanel'

const app = document.getElementById('app')!
const channelRepo = new IptvOrgChannelRepository()

const api = createDockview(app, {
  createComponent({ name }) {
    if (name === 'tv') {
      return { element: createTVPanel(channelRepo), init: () => {} }
    }

    const handle = createTerminalPanel()
    return {
      element: handle.element,
      init: () => {},
      dispose: () => handle.dispose(),
    }
  },
})

const layout = createDefaultLayout()
const [left, right] = layout.panels

api.addPanel({ id: left.id, component: left.type, title: left.title })
api.addPanel({
  id: right.id,
  component: right.type,
  title: right.title,
  position: { referencePanel: left.id, direction: 'right' },
})

// Nueva terminal como tab junto a la última terminal activa
let terminalCounter = 1

function addTerminal(): void {
  terminalCounter++
  const id = `terminal-${terminalCounter}`
  const lastTerminal = api.panels.find(p => p.id.startsWith('terminal-'))

  api.addPanel({
    id,
    component: 'terminal',
    title: `Terminal ${terminalCounter}`,
    position: lastTerminal
      ? { referencePanel: lastTerminal.id, direction: 'within' }
      : undefined,
  })
}

window.addEventListener('keydown', e => {
  const isNewTerminal = (e.metaKey || e.ctrlKey) && e.key === 't'
  if (!isNewTerminal) return
  e.preventDefault()
  addTerminal()
})
