import { invoke } from '@tauri-apps/api/core'
import { parseDockerPs } from '../../core/db/dockerPs'
import { serverKind } from '../../core/db/serverKind'
import { publishedPort } from '../../core/db/hostPort'
import { mysqlCreds, mongoCreds, pgCreds } from '../../core/db/credentials'
import { DEFAULT_PORT, LISTABLE, kindForPort, type DbServer, type DbKind } from '../../core/db/dbServer'
import { icon } from '../../ui/icons'

const KIND_LABEL: Record<DbKind, string> = {
  mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', postgres: 'PostgreSQL', redis: 'Redis',
}

interface TableData { columns: string[]; rows: string[][] }

const isMongo = (s: DbServer): boolean => s.kind === 'mongodb'
const isPg = (s: DbServer): boolean => s.kind === 'postgres'
const isRedis = (s: DbServer): boolean => s.kind === 'redis'
const envValue = (env: string[], key: string): string => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? ''
// SQL engines share the same grid logic; only the command prefix differs.
const sqlCmd = (s: DbServer, op: string): string => `db_docker_${isPg(s) ? 'pg' : 'mysql'}_${op}`
const creds = (s: DbServer): { user: string; password: string } => ({ user: s.user ?? '', password: s.password ?? '' })

const note = (text: string, cls = 'db-note'): HTMLElement => {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = text
  return el
}

const prettyJson = (json: string): string => {
  try { return JSON.stringify(JSON.parse(json), null, 2) } catch { return json }
}

export function createDbPanel(): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'db-panel'

  const header = document.createElement('div')
  header.className = 'db-header'
  const title = document.createElement('span')
  title.className = 'db-title'
  title.textContent = 'Bases de datos'
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'db-action'
  refreshBtn.title = 'Volver a detectar'
  refreshBtn.innerHTML = icon('refresh')
  header.append(title, refreshBtn)

  const body = document.createElement('div')
  body.className = 'db-body'
  const tree = document.createElement('div')
  tree.className = 'db-tree'
  const detail = document.createElement('div')
  detail.className = 'db-detail'
  body.append(tree, detail)
  root.append(header, body)

  const showDetail = (...nodes: HTMLElement[]): void => { detail.replaceChildren(...nodes) }
  showDetail(note('Selecciona una tabla o colección para ver sus datos.', 'db-detail-hint'))

  // ---- detection (same as before) ----
  const detectDocker = async (): Promise<DbServer[]> => {
    const raw = await invoke<string>('db_docker_ps').catch(() => '')
    const servers: DbServer[] = []
    for (const c of parseDockerPs(raw)) {
      const kind = serverKind(c.image, c.ports)
      if (!kind) continue
      const port = publishedPort(c.ports, DEFAULT_PORT[kind]) ?? DEFAULT_PORT[kind]
      servers.push({ kind, source: 'docker', host: '127.0.0.1', port, container: c.name })
    }
    return servers
  }

  const detectLocal = async (taken: Set<number>): Promise<DbServer[]> => {
    const ports = [...new Set(Object.values(DEFAULT_PORT))]
    const open = await invoke<number[]>('db_check_ports', { ports }).catch(() => [] as number[])
    return open
      .filter(p => !taken.has(p))
      .map(p => ({ kind: kindForPort(p)!, source: 'local', host: '127.0.0.1', port: p } as DbServer))
  }

  // ---- credentials ----
  const resolveCreds = async (s: DbServer): Promise<void> => {
    if (s.source === 'docker' && s.container) {
      const env = await invoke<string[]>('db_inspect_env', { container: s.container }).catch(() => [] as string[])
      if (isPg(s)) {
        const c = pgCreds(env)
        s.user = c.user; s.password = c.password; s.connectDb = c.db
      } else if (isRedis(s)) {
        s.password = envValue(env, 'REDIS_PASSWORD')
      } else {
        const c = isMongo(s) ? mongoCreds(env) : mysqlCreds(env)
        s.user = c.user; s.password = c.password
      }
      return
    }
    s.user = isMongo(s) ? '' : 'root'
    s.password = ''
  }

  // ---- data access (Docker only for table browsing) ----
  const listDatabases = (s: DbServer): Promise<string[]> => {
    if (s.source === 'docker' && s.container) {
      if (isRedis(s)) return invoke<string[]>('db_docker_redis_dbs', { container: s.container, password: s.password ?? '' })
      if (isMongo(s)) return invoke<string[]>('db_docker_list_mongo', { container: s.container, ...creds(s) })
      if (isPg(s)) return invoke<string[]>('db_docker_pg_databases', { container: s.container, db: s.connectDb ?? 'postgres', ...creds(s) })
      return invoke<string[]>('db_docker_list_mysql', { container: s.container, ...creds(s) })
    }
    if (isPg(s) || isRedis(s)) return Promise.reject(`${KIND_LABEL[s.kind]}: solo Docker por ahora.`)
    const cmd = isMongo(s) ? 'db_list_mongo' : 'db_list_mysql'
    return invoke<string[]>(cmd, { host: s.host, port: s.port, ...creds(s) })
  }

  const listTables = (s: DbServer, db: string): Promise<string[]> => {
    if (s.source !== 'docker' || !s.container) return Promise.reject('Explorar: solo Docker por ahora.')
    if (isRedis(s)) return invoke<string[]>('db_docker_redis_keys', { container: s.container, db, password: s.password ?? '' })
    const cmd = isMongo(s) ? 'db_docker_mongo_collections' : sqlCmd(s, 'tables')
    return invoke<string[]>(cmd, { container: s.container, db, ...creds(s) })
  }

  const renderRedisValue = (db: string, key: string, v: { kind: string; value: string }): void => {
    const pre = document.createElement('pre')
    pre.className = 'db-doc'
    pre.textContent = v.value || '(vacío)'
    const scroll = document.createElement('div')
    scroll.className = 'db-docs'
    scroll.appendChild(pre)
    showDetail(detailHead(`db${db} · ${key}`, v.kind), scroll)
  }

  const openData = async (s: DbServer, db: string, name: string): Promise<void> => {
    showDetail(note('Cargando…', 'db-detail-loading'))
    try {
      if (isRedis(s)) {
        const v = await invoke<{ kind: string; value: string }>('db_docker_redis_value', { container: s.container, db, key: name, password: s.password ?? '' })
        renderRedisValue(db, name, v)
        return
      }
      if (isMongo(s)) {
        const docs = await invoke<string[]>('db_docker_mongo_docs', { container: s.container, db, collection: name, ...creds(s) })
        renderDocs(s, db, name, docs)
      } else {
        const [data, pk] = await Promise.all([
          invoke<TableData>(sqlCmd(s, 'rows'), { container: s.container, db, table: name, ...creds(s) }),
          invoke<string[]>(sqlCmd(s, 'pk'), { container: s.container, db, table: name, ...creds(s) }).catch(() => [] as string[]),
        ])
        renderGrid(s, db, name, data, pk)
      }
    } catch (e) {
      showDetail(note(String(e), 'db-detail-error'))
    }
  }

  // ---- detail renderers ----
  const detailHead = (path: string, count: string): HTMLElement => {
    const bar = document.createElement('div')
    bar.className = 'db-detail-head'
    const p = document.createElement('span')
    p.className = 'db-detail-path'
    p.textContent = path
    const c = document.createElement('span')
    c.className = 'db-detail-count'
    c.textContent = count
    bar.append(p, c)
    return bar
  }

  const editCell = (
    s: DbServer, db: string, table: string, columns: string[],
    row: string[], colIdx: number, pkIdx: number[], td: HTMLElement,
  ): void => {
    const column = columns[colIdx]
    const old = row[colIdx]
    const input = document.createElement('input')
    input.className = 'db-cell-input'
    input.value = old === 'NULL' ? '' : old
    td.replaceChildren(input)
    input.focus()
    input.select()
    let done = false
    const restore = (): void => { td.textContent = old; td.classList.toggle('db-null', old === 'NULL') }
    const commit = async (): Promise<void> => {
      if (done) return
      done = true
      const value = input.value
      if (value === old) { restore(); return }
      const wheres = pkIdx.map(i => [columns[i], row[i]] as [string, string])
      const summary = `UPDATE ${table}\nSET ${column} = '${value}'\nWHERE ${wheres.map(([c, v]) => `${c}=${v}`).join(' AND ')}`
      if (!confirm(summary)) { restore(); return }
      try {
        await invoke(sqlCmd(s, 'update'), { container: s.container, db, table, column, value, wheres, ...creds(s) })
        row[colIdx] = value
        td.textContent = value
        td.classList.remove('db-null')
      } catch (e) {
        alert(String(e))
        restore()
      }
    }
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur() }
      else if (e.key === 'Escape') { done = true; restore() }
    })
    input.addEventListener('blur', commit)
  }

  const deleteRow = async (
    s: DbServer, db: string, table: string, columns: string[],
    row: string[], pkIdx: number[], tr: HTMLElement,
  ): Promise<void> => {
    const wheres = pkIdx.map(i => [columns[i], row[i]] as [string, string])
    if (!confirm(`DELETE FROM ${table}\nWHERE ${wheres.map(([c, v]) => `${c}=${v}`).join(' AND ')}`)) return
    try {
      await invoke(sqlCmd(s, 'delete'), { container: s.container, db, table, wheres, ...creds(s) })
      tr.remove()
    } catch (e) {
      alert(String(e))
    }
  }

  const renderGrid = (s: DbServer, db: string, table: string, data: TableData, pk: string[]): void => {
    const pkIdx = pk.map(c => data.columns.indexOf(c)).filter(i => i >= 0)
    const editable = pkIdx.length > 0
    const scroll = document.createElement('div')
    scroll.className = 'db-grid-scroll'
    if (!data.columns.length) {
      scroll.append(note('Sin filas.'))
    } else {
      const tbl = document.createElement('table')
      tbl.className = 'db-grid'
      const thead = document.createElement('thead')
      const htr = document.createElement('tr')
      data.columns.forEach(col => {
        const th = document.createElement('th')
        th.textContent = col
        htr.appendChild(th)
      })
      if (editable) htr.appendChild(document.createElement('th'))
      thead.appendChild(htr)
      const tbody = document.createElement('tbody')
      data.rows.forEach(row => {
        const tr = document.createElement('tr')
        row.forEach((cell, colIdx) => {
          const td = document.createElement('td')
          td.textContent = cell
          if (cell === 'NULL') td.classList.add('db-null')
          if (editable) {
            td.classList.add('db-editable')
            td.addEventListener('dblclick', () => editCell(s, db, table, data.columns, row, colIdx, pkIdx, td))
          }
          tr.appendChild(td)
        })
        if (editable) {
          const actions = document.createElement('td')
          actions.className = 'db-row-actions'
          const del = document.createElement('button')
          del.className = 'db-del'
          del.title = 'Borrar fila'
          del.innerHTML = icon('trash')
          del.addEventListener('click', () => deleteRow(s, db, table, data.columns, row, pkIdx, tr))
          actions.appendChild(del)
          tr.appendChild(actions)
        }
        tbody.appendChild(tr)
      })
      tbl.append(thead, tbody)
      scroll.appendChild(tbl)
    }
    const hint = editable ? 'doble clic para editar' : 'sin PK · solo lectura'
    showDetail(detailHead(`${db}.${table}`, `${data.rows.length} filas · ${hint}`), scroll)
  }

  const editDoc = (s: DbServer, db: string, coll: string, pre: HTMLElement): void => {
    const original = pre.textContent ?? ''
    const ta = document.createElement('textarea')
    ta.className = 'db-doc-edit'
    ta.value = original
    const actions = document.createElement('div')
    actions.className = 'db-doc-actions'
    const save = document.createElement('button')
    save.className = 'db-connect'
    save.textContent = 'Guardar'
    const cancel = document.createElement('button')
    cancel.className = 'db-doc-cancel'
    cancel.textContent = 'Cancelar'
    actions.append(save, cancel)
    const wrap = document.createElement('div')
    wrap.className = 'db-doc-wrap'
    wrap.append(ta, actions)
    pre.replaceWith(wrap)
    ta.focus()
    const restore = (text: string): void => {
      const p = document.createElement('pre')
      p.className = 'db-doc'
      p.textContent = text
      p.addEventListener('dblclick', () => editDoc(s, db, coll, p))
      wrap.replaceWith(p)
    }
    cancel.addEventListener('click', () => restore(original))
    save.addEventListener('click', async () => {
      if (!confirm('Reemplazar el documento (por _id)?')) return
      try {
        await invoke('db_docker_mongo_update', { container: s.container, db, collection: coll, doc: ta.value, ...creds(s) })
        restore(prettyJson(ta.value))
      } catch (e) {
        alert(String(e))
      }
    })
  }

  const deleteDoc = async (s: DbServer, db: string, coll: string, item: HTMLElement, current: string): Promise<void> => {
    if (!confirm('¿Borrar este documento?')) return
    try {
      await invoke('db_docker_mongo_delete', { container: s.container, db, collection: coll, doc: current, ...creds(s) })
      item.remove()
    } catch (e) {
      alert(String(e))
    }
  }

  const renderDocs = (s: DbServer, db: string, coll: string, docs: string[]): void => {
    const scroll = document.createElement('div')
    scroll.className = 'db-docs'
    if (!docs.length) {
      scroll.append(note('Sin documentos.'))
    } else {
      docs.forEach(d => {
        const item = document.createElement('div')
        item.className = 'db-doc-item'
        const del = document.createElement('button')
        del.className = 'db-del db-doc-del'
        del.title = 'Borrar documento'
        del.innerHTML = icon('trash')
        del.addEventListener('click', () => deleteDoc(s, db, coll, item, item.querySelector('.db-doc')?.textContent ?? prettyJson(d)))
        const pre = document.createElement('pre')
        pre.className = 'db-doc'
        pre.textContent = prettyJson(d)
        pre.addEventListener('dblclick', () => editDoc(s, db, coll, pre))
        item.append(del, pre)
        scroll.appendChild(item)
      })
    }
    showDetail(detailHead(`${db}.${coll}`, `${docs.length} documentos · doble clic para editar`), scroll)
  }

  // ---- tree ----
  const rowEl = (depth: number, iconName: string, label: string, expandable: boolean): HTMLButtonElement => {
    const row = document.createElement('button')
    row.className = 'db-row'
    row.style.paddingLeft = `${8 + depth * 14}px`
    if (expandable) {
      const chevron = document.createElement('span')
      chevron.className = 'db-chevron'
      chevron.innerHTML = icon('chevron')
      row.appendChild(chevron)
    }
    const ic = document.createElement('span')
    ic.className = 'db-row-icon'
    ic.innerHTML = icon(iconName)
    const lbl = document.createElement('span')
    lbl.className = 'db-row-label'
    lbl.textContent = label
    row.append(ic, lbl)
    return row
  }

  const appendExpandable = (
    parent: HTMLElement,
    row: HTMLButtonElement,
    onFirstExpand: (children: HTMLElement) => void,
  ): void => {
    const children = document.createElement('div')
    children.className = 'db-children hidden'
    let loaded = false
    row.addEventListener('click', () => {
      const open = children.classList.contains('hidden')
      row.classList.toggle('open', open)
      children.classList.toggle('hidden', !open)
      if (open && !loaded) { loaded = true; onFirstExpand(children) }
    })
    parent.append(row, children)
  }

  const selectLeaf = (row: HTMLElement): void => {
    tree.querySelectorAll('.db-leaf.selected').forEach(el => el.classList.remove('selected'))
    row.classList.add('selected')
  }

  const credsForm = (container: HTMLElement, s: DbServer, retry: () => void): void => {
    container.replaceChildren(note('Conexión fallida. Prueba con otras credenciales:', 'db-error'))
    const userIn = document.createElement('input')
    userIn.className = 'db-input'
    userIn.placeholder = 'usuario'
    userIn.value = s.user ?? ''
    const passIn = document.createElement('input')
    passIn.className = 'db-input'
    passIn.type = 'password'
    passIn.placeholder = 'contraseña'
    passIn.value = s.password ?? ''
    const btn = document.createElement('button')
    btn.className = 'db-connect'
    btn.textContent = 'Conectar'
    btn.addEventListener('click', () => { s.user = userIn.value; s.password = passIn.value; retry() })
    container.append(userIn, passIn, btn)
  }

  const populateTables = async (s: DbServer, db: string, container: HTMLElement): Promise<void> => {
    container.replaceChildren(note('Cargando…'))
    try {
      const names = await listTables(s, db)
      container.replaceChildren()
      if (!names.length) { container.append(note('Vacío.')); return }
      names.forEach(name => {
        const row = rowEl(2, isMongo(s) || isRedis(s) ? 'list' : 'table', name, false)
        row.classList.add('db-leaf')
        row.addEventListener('click', () => { selectLeaf(row); openData(s, db, name) })
        container.appendChild(row)
      })
    } catch (e) {
      container.replaceChildren(note(String(e), 'db-error'))
    }
  }

  const populateDatabases = async (s: DbServer, container: HTMLElement): Promise<void> => {
    container.replaceChildren(note('Conectando…'))
    try {
      const names = await listDatabases(s)
      container.replaceChildren()
      if (!names.length) { container.append(note(isRedis(s) ? 'Redis vacío (sin claves).' : 'Sin bases.')); return }
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
      tree.append(note('No se detectaron servidores. ¿Está Docker corriendo o hay alguna base de datos local?', 'db-hint'))
      return
    }
    servers.forEach(s => {
      const row = rowEl(0, 'database', KIND_LABEL[s.kind], true)
      const badge = document.createElement('span')
      badge.className = `db-server-badge db-badge-${s.source}`
      badge.textContent = s.source === 'docker' ? (s.container ?? 'docker') : 'local'
      const addr = document.createElement('span')
      addr.className = 'db-server-addr'
      addr.textContent = s.source === 'docker' ? `:${s.port}` : `${s.host}:${s.port}`
      row.append(badge, addr)
      appendExpandable(tree, row, async child => {
        if (!LISTABLE.includes(s.kind)) { child.replaceChildren(note('Listado no soportado todavía.')); return }
        child.replaceChildren(note('Conectando…'))
        await resolveCreds(s)
        populateDatabases(s, child)
      })
    })
  }

  const detect = async (): Promise<void> => {
    tree.replaceChildren(note('Detectando…'))
    const docker = await detectDocker()
    const local = await detectLocal(new Set(docker.map(s => s.port)))
    renderServers([...docker, ...local])
  }

  refreshBtn.addEventListener('click', detect)
  detect()

  return { element: root }
}
