import { t as i18nT } from '../../i18n'
import { icon } from '../../ui/helpers/icons'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { note } from './dbWidgets'
import { detectDocker, detectLocal } from './dbDetect'
import { createDetailHost } from './dbDetailHost'
import { openData } from './dbOpenData'
import { openQuery } from './dbQueryView'
import { createDbTree } from './dbTree'

export function createDbPanel(): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'db-panel'

  // Re-detect action lives in the sidebar header.
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'db-action'
  refreshBtn.title = i18nT('db.detectAgain')
  refreshBtn.innerHTML = icon('refresh')

  const body = document.createElement('div')
  body.className = 'db-body'

  const cs = createCollapsibleSidebar({
    storageKey: 'bento.db.sidebar',
    title: i18nT('db.databases'),
    defaultWidth: 250,
    minWidth: 160,
    minRemaining: 420,
    container: body,
  })
  cs.actions.append(refreshBtn)

  const tree = document.createElement('div')
  tree.className = 'db-tree'
  cs.list.append(tree)

  const detail = document.createElement('div')
  detail.className = 'db-detail'
  body.append(cs.element, cs.resizer, detail)
  root.append(body)

  const host = createDetailHost(detail)
  host.showDetail(note(i18nT('db.selectATableOrCollectionToViewIts'), 'db-detail-hint'))

  const { renderServers } = createDbTree({
    element: tree,
    onOpenData: (s, db, name) => void openData(host, s, db, name),
    onOpenQuery: (s, db, names) => openQuery(host, s, db, names),
  })

  const detect = async (): Promise<void> => {
    tree.replaceChildren(note(i18nT('db.detecting')))
    const docker = await detectDocker()
    const local = await detectLocal(new Set(docker.map(srv => srv.port)))
    renderServers([...docker, ...local])
  }

  refreshBtn.addEventListener('click', detect)
  detect()

  return { element: root }
}
