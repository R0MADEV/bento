import { createDockview } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createDefaultLayout } from './workspace/layout'

const app = document.getElementById('app')!

const api = createDockview(app, {
  createComponent({ name }) {
    const el = document.createElement('div')
    el.className = 'panel-placeholder'

    const labels: Record<string, string> = {
      tv: '📺 TV Panel',
      terminal: '> Terminal Panel',
    }

    el.textContent = labels[name] ?? name

    return {
      element: el,
      init: () => {},
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
