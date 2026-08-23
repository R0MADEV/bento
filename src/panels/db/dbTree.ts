import { t as i18nT } from '../../i18n'
import { LISTABLE, type DbServer } from '../../core/db/dbServer'
import { KIND_LABEL, isMongo, isRedis } from '../../core/db/dbEngine'
import { fetchColumns, listDatabases, listTables } from './dbAccess'
import { note, rowEl, appendExpandable } from './dbWidgets'
import { resolveCreds } from './dbDetect'

// Tables are revealed a page at a time: a large DB has thousands of them.
const TREE_PAGE = 30

export interface DbTreeDeps {
  element: HTMLElement
  onOpenData: (s: DbServer, db: string, name: string) => void
  onOpenQuery: (s: DbServer, db: string, names: string[]) => void
}

export interface DbTree {
  renderServers: (servers: DbServer[]) => void
}

/** The sidebar tree: servers → databases → tables/collections/keys → columns. */
export function createDbTree(deps: DbTreeDeps): DbTree {
  const { element, onOpenData, onOpenQuery } = deps
const selectLeaf = (row: HTMLElement): void => {
  element.querySelectorAll('.db-leaf.selected').forEach(el => el.classList.remove('selected'))
  row.classList.add('selected')
}

const credsForm = (container: HTMLElement, s: DbServer, retry: () => void): void => {
  container.replaceChildren(note(i18nT('db.connectionFailedTryDifferentCredentials'), 'db-error'))
  const userIn = document.createElement('input')
  userIn.className = 'db-input'
  userIn.placeholder = i18nT('db.userPlaceholder')
  userIn.value = s.user ?? ''
  const passIn = document.createElement('input')
  passIn.className = 'db-input'
  passIn.type = 'password'
  passIn.placeholder = i18nT('db.password')
  passIn.value = s.password ?? ''
  const btn = document.createElement('button')
  btn.className = 'db-connect'
  btn.textContent = i18nT('common.connect')
  btn.addEventListener('click', () => { s.user = userIn.value; s.password = passIn.value; retry() })
  container.append(userIn, passIn, btn)
}

const populateTables = async (s: DbServer, db: string, container: HTMLElement): Promise<void> => {
  container.replaceChildren(note(i18nT('common.loading')))
  try {
    const names = await listTables(s, db)
    container.replaceChildren()
    // Free-form query (SQL / mongosh / redis-cli depending on the DB type).
    const queryRow = rowEl(2, 'scripts', i18nT('db.newQuery'), false)
    queryRow.classList.add('db-leaf', 'db-query-leaf')
    queryRow.addEventListener('click', () => { selectLeaf(queryRow); onOpenQuery(s, db, names) })
    container.appendChild(queryRow)
    if (!names.length) { container.append(note(i18nT('db.noTables'))); return }
    const isLeaf = isMongo(s) || isRedis(s)
      let offset = 0
    const addRow = (name: string): void => {
      const row = rowEl(2, isRedis(s) ? 'list' : isMongo(s) ? 'list' : 'table', name, !isLeaf)
      row.classList.add('db-leaf')
      row.addEventListener('click', () => { selectLeaf(row); onOpenData(s, db, name) })
      if (isLeaf) {
        container.appendChild(row)
      } else {
        appendExpandable(container, row, async children => {
          children.append(note(i18nT('common.loading')))
          const cols = await fetchColumns(s, db, name)
          children.replaceChildren()
          if (!cols.length) { children.append(note('—')); return }
          cols.forEach(colStr => {
            const div = document.createElement('div')
            div.className = 'db-col-row'
            div.textContent = colStr
            children.appendChild(div)
          })
        })
      }
    }
    const showPage = (): void => {
      container.querySelector('.db-tree-more')?.remove()
      names.slice(offset, offset + TREE_PAGE).forEach(addRow)
      offset += TREE_PAGE
      if (offset < names.length) {
        const more = document.createElement('button')
        more.className = 'db-row db-tree-more'
        more.style.paddingLeft = `${8 + 2 * 14}px`
        more.textContent = i18nT('db.showMore', { count: names.length - offset })
        more.addEventListener('click', showPage)
        container.appendChild(more)
      }
    }
    showPage()
  } catch (e) {
    container.replaceChildren(note(String(e), 'db-error'))
  }
}

const populateDatabases = async (s: DbServer, container: HTMLElement): Promise<void> => {
  container.replaceChildren(note(i18nT('db.connecting')))
  try {
    const names = await listDatabases(s)
    container.replaceChildren()
    if (!names.length) { container.append(note(isRedis(s) ? i18nT('db.emptyRedisDatabaseNoKeys') : i18nT('db.noDatabases'))); return }
    names.forEach(db => {
      const row = rowEl(1, 'database', isRedis(s) ? `db${db}` : db, true)
      appendExpandable(container, row, child => populateTables(s, db, child))
    })
  } catch {
    credsForm(container, s, () => populateDatabases(s, container))
  }
}

const renderServers = (servers: DbServer[]): void => {
  element.replaceChildren()
  if (!servers.length) {
    element.append(note(i18nT('db.noServersWereDetectedIsDockerRunningOr'), 'db-hint'))
    return
  }
  servers.forEach(s => {
    const row = rowEl(0, 'database', KIND_LABEL[s.kind], true)
    const badge = document.createElement('span')
    badge.className = `db-server-badge db-badge-${s.source}`
    badge.textContent = s.source === 'docker' ? (s.container ?? i18nT('db.dockerSource')) : i18nT('db.localSource')
    const addr = document.createElement('span')
    addr.className = 'db-server-addr'
    addr.textContent = s.source === 'docker' ? `:${s.port}` : `${s.host}:${s.port}`
    row.append(badge, addr)
    appendExpandable(element, row, async child => {
      if (!LISTABLE.includes(s.kind)) { child.replaceChildren(note(i18nT('db.listingIsNotSupportedYet'))); return }
      child.replaceChildren(note(i18nT('db.connecting')))
      await resolveCreds(s)
      populateDatabases(s, child)
    })
  })
}

  return { renderServers }
}
