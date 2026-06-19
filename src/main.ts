import { createDockview } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createDefaultLayout } from './core/workspace/layout'
import { IptvOrgChannelRepository } from './adapters/IptvOrgChannelRepository'
import { createTVPanel } from './panels/tv/TVPanel'

const app = document.getElementById('app')!
const channelRepo = new IptvOrgChannelRepository()

const api = createDockview(app, {
  createComponent({ name }) {
    if (name === 'tv') {
      return { element: createTVPanel(channelRepo), init: () => {} }
    }

    const el = document.createElement('div')
    el.className = 'panel-placeholder'
    el.textContent = '> Terminal Panel'
    return { element: el, init: () => {} }
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
