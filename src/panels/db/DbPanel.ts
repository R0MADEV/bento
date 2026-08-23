import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { LISTABLE, type DbServer } from '../../core/db/dbServer'
import { icon } from '../../ui/icons'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import type { ForeignKey } from './queryBuilders'
import {
  KIND_LABEL, isMongo, isRedis, sqlCmd, creds, target,
  fetchColumns, listDatabases, listTables, fetchRelations,
  type TableData,
} from './dbAccess'
import { note, rowEl, appendExpandable } from './dbWidgets'
import { detectDocker, detectLocal, resolveCreds } from './dbDetect'
import { createDetailHost } from './dbDetailHost'
import { renderGrid } from './dbTableGrid'
import { renderDocs } from './dbDocsView'
import { renderRedisValue } from './dbRedisView'
import { createQueryHistory } from './dbQueryHistory'
import { createQueryRunner } from './dbQueryExec'
import { createAiQueryButton } from './dbQueryAi'
import { createJoinBuilder } from './dbJoinBuilder'
import { createQueryChips } from './dbQueryChips'

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

  const { showDetail, detailHead } = createDetailHost(detail)
  showDetail(note(i18nT('db.selectATableOrCollectionToViewIts'), 'db-detail-hint'))

  const openData = async (s: DbServer, db: string, name: string): Promise<void> => {
    showDetail(note(i18nT('common.loading'), 'db-detail-loading'))
    try {
      if (isRedis(s)) {
        const [v, ttl] = await Promise.all([
          invoke<{ kind: string; value: string }>('db_docker_redis_value', { ...target(s), db, key: name, password: s.password ?? '' }),
          invoke<number>('db_docker_redis_ttl', { ...target(s), db, key: name, password: s.password ?? '' }).catch(() => -2),
        ])
        renderRedisValue({ showDetail, detailHead }, s, db, name, v, ttl)
        return
      }
      if (isMongo(s)) {
        const docs = await invoke<string[]>('db_docker_mongo_docs', { ...target(s), db, collection: name, ...creds(s) })
        renderDocs({ showDetail, detailHead }, s, db, name, docs)
      } else {
        const [data, pk] = await Promise.all([
          invoke<TableData>(sqlCmd(s, 'rows'), { ...target(s), db, table: name, ...creds(s) }),
          invoke<string[]>(sqlCmd(s, 'pk'), { ...target(s), db, table: name, ...creds(s) }).catch(() => [] as string[]),
        ])
        const fkColMap = new Map<string, { ref_table: string; ref_column: string }>()
        fetchRelations(s, db).then(fks => {
          fks.filter(f => f.table === name).forEach(f => fkColMap.set(f.column, { ref_table: f.ref_table, ref_column: f.ref_column }))
        }).catch(() => {})
        renderGrid({ showDetail, detailHead }, s, db, name, data, pk, fkColMap, () => openData(s, db, name))
      }
    } catch (e) {
      showDetail(note(String(e), 'db-detail-error'))
    }
  }

  const openQuery = (s: DbServer, db: string, names: string[]): void => {
    // Relations loaded once and shared (chips, AI, and the JOIN builder).
    let relations: ForeignKey[] = []
    const relationsReady = fetchRelations(s, db).then(r => { relations = r; return r })

    const editor = document.createElement('textarea')
    editor.className = 'db-query-input'
    editor.spellcheck = false
    editor.placeholder = isMongo(s)
      ? i18nT('db.mongoPlaceholder')
      : isRedis(s)
        ? i18nT('db.redisPlaceholder')
        : i18nT('db.sqlPlaceholder')
    const runBtn = document.createElement('button')
    runBtn.className = 'db-connect'
    runBtn.textContent = i18nT('db.runShortcut')

    const history = createQueryHistory(s, db, q => { editor.value = q; editor.focus() })
    const { executeQuery, explain } = createQueryRunner(s, db, names, relationsReady)
    const aiBtn = createAiQueryButton({ s, db, names, relationsReady, executeQuery, fetchColumns })
    const joinBuilder = createJoinBuilder({
      s, names, getRelations: () => relations, relationsReady,
      onBuild: q => { editor.value = q; editor.focus() },
    })
    const chips = createQueryChips({ s, names, relationsReady, onPick: q => { editor.value = q; editor.focus() } })

    const actions = document.createElement('div')
    actions.className = 'db-query-actions'
    actions.append(runBtn, aiBtn, history.element)

    const bar = document.createElement('div')
    bar.className = 'db-query-bar'
    bar.append(editor, actions, joinBuilder, chips)

    const resultArea = document.createElement('div')
    resultArea.className = 'db-grid-scroll'
    resultArea.append(note(i18nT('db.writeAQueryAndRunIt'), 'db-detail-hint'))

    const run = async (): Promise<void> => {
      const text = editor.value.trim()
      if (!text) return
      resultArea.replaceChildren(note(i18nT('db.running'), 'db-detail-loading'))
      try {
        const result = await executeQuery(text)
        history.saveHistory(text)
        resultArea.replaceChildren(result)
      } catch (e) {
        const errEl = note(String(e), 'db-detail-error')
        const isExplainable = !isMongo(s) && !isRedis(s) && /^\s*(select|with)\b/i.test(text)
        if (!isExplainable) { resultArea.replaceChildren(errEl); return }
        const explainBtn = document.createElement('button')
        explainBtn.className = 'db-query-run'
        explainBtn.textContent = i18nT('db.seeWhyExplain')
        explainBtn.addEventListener('click', async () => {
          explainBtn.disabled = true
          explainBtn.textContent = i18nT('db.analyzing')
          try {
            resultArea.replaceChildren(await explain(text))
          } catch (e2) {
            resultArea.replaceChildren(errEl, note(String(e2), 'db-detail-error'))
          }
        })
        resultArea.replaceChildren(errEl, explainBtn)
      }
    }
    runBtn.addEventListener('click', run)
    editor.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run() }
    })

    showDetail(detailHead(i18nT('db.queryLabel', { name: db }), KIND_LABEL[s.kind]), bar, resultArea)
    editor.focus()
  }

  // ---- tree ----
  const selectLeaf = (row: HTMLElement): void => {
    tree.querySelectorAll('.db-leaf.selected').forEach(el => el.classList.remove('selected'))
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
      queryRow.addEventListener('click', () => { selectLeaf(queryRow); openQuery(s, db, names) })
      container.appendChild(queryRow)
      if (!names.length) { container.append(note(i18nT('db.noTables'))); return }
      const isLeaf = isMongo(s) || isRedis(s)
      const TREE_PAGE = 30
      let offset = 0
      const addRow = (name: string): void => {
        const row = rowEl(2, isRedis(s) ? 'list' : isMongo(s) ? 'list' : 'table', name, !isLeaf)
        row.classList.add('db-leaf')
        row.addEventListener('click', () => { selectLeaf(row); openData(s, db, name) })
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
    tree.replaceChildren()
    if (!servers.length) {
      tree.append(note(i18nT('db.noServersWereDetectedIsDockerRunningOr'), 'db-hint'))
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
      appendExpandable(tree, row, async child => {
        if (!LISTABLE.includes(s.kind)) { child.replaceChildren(note(i18nT('db.listingIsNotSupportedYet'))); return }
        child.replaceChildren(note(i18nT('db.connecting')))
        await resolveCreds(s)
        populateDatabases(s, child)
      })
    })
  }

  const detect = async (): Promise<void> => {
    tree.replaceChildren(note(i18nT('db.detecting')))
    const docker = await detectDocker()
    const local = await detectLocal(new Set(docker.map(s => s.port)))
    renderServers([...docker, ...local])
  }

  refreshBtn.addEventListener('click', detect)
  detect()

  return { element: root }
}
