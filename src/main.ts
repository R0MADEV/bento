import { DockviewComponent } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import './styles.css'
import { createDefaultLayout } from './workspace/layout'

const app = document.getElementById('app')!

const dockview = new DockviewComponent({
  parentElement: app,
  components: {
    tv: {
      createComponent(id, _componentId, _params) {
        const el = document.createElement('div')
        el.className = 'panel-placeholder'
        el.textContent = '📺 TV Panel'
        return { element: el, init: () => {}, dispose: () => {} }
      },
    },
    terminal: {
      createComponent(id, _componentId, _params) {
        const el = document.createElement('div')
        el.className = 'panel-placeholder'
        el.textContent = '> Terminal Panel'
        return { element: el, init: () => {}, dispose: () => {} }
      },
    },
  },
})

const layout = createDefaultLayout()

const [left, right] = layout.panels

dockview.addPanel({ id: left.id, component: left.type, title: left.title })
dockview.addPanel({
  id: right.id,
  component: right.type,
  title: right.title,
  position: { referencePanel: left.id, direction: 'right' },
})
