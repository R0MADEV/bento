import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { parseDockerPs } from '../../core/db/dockerPs'
import { serverKind } from '../../core/db/serverKind'
import { publishedPort } from '../../core/db/hostPort'
import { mysqlCreds, mongoCreds, pgCreds } from '../../core/db/credentials'
import { DEFAULT_PORT, LISTABLE, kindForPort, type DbServer, type DbKind } from '../../core/db/dbServer'
import { icon } from '../../ui/icons'
import { askAi, type AiQueryRunner, type AiTool } from '../../ui/askAi'
import { buildJoinPath, type Relation, type JoinPlan } from '../../core/db/joinPath'
import { withRowLimit } from '../../core/db/rowLimit'

// Counter for unique datalist ids (several DB panels/views at once).
let joinListSeq = 0

const KIND_LABEL: Record<DbKind, string> = {
  mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', postgres: 'PostgreSQL', redis: 'Redis',
}

interface TableData { columns: string[]; rows: string[][] }
interface ForeignKey { table: string; column: string; ref_table: string; ref_column: string }

const isMongo = (s: DbServer): boolean => s.kind === 'mongodb'
const isPg = (s: DbServer): boolean => s.kind === 'postgres'
const isRedis = (s: DbServer): boolean => s.kind === 'redis'
const envValue = (env: string[], key: string): string => env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? ''
// SQL engines share the same grid logic; only the command prefix differs.
const sqlCmd = (s: DbServer, op: string): string => `db_docker_${isPg(s) ? 'pg' : 'mysql'}_${op}`
const creds = (s: DbServer): { user: string; password: string } => ({ user: s.user ?? '', password: s.password ?? '' })
// Where to run: a Docker container, or a local server (empty container → host:port).
const target = (s: DbServer): { container: string; host: string; port: number } => ({ container: s.container ?? '', host: s.host, port: s.port })

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
  title.textContent = i18nT('db.databases')
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'db-action'
  refreshBtn.title = i18nT('db.detectAgain')
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
  showDetail(note(i18nT('db.selectATableOrCollectionToViewIts'), 'db-detail-hint'))

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
    // Local (non-Docker): sensible default users per engine; no env to read.
    s.password = ''
    if (isPg(s)) { s.user = 'postgres'; s.connectDb = 'postgres' }
    else if (isMongo(s) || isRedis(s)) { s.user = '' }
    else { s.user = 'root' }
  }

  // ---- data access (Docker via exec, local via the host's own client) ----
  const listDatabases = (s: DbServer): Promise<string[]> => {
    if (isRedis(s)) return invoke<string[]>('db_docker_redis_dbs', { ...target(s), password: s.password ?? '' })
    if (isMongo(s)) return invoke<string[]>('db_docker_list_mongo', { ...target(s), ...creds(s) })
    if (isPg(s)) return invoke<string[]>('db_docker_pg_databases', { ...target(s), db: s.connectDb ?? 'postgres', ...creds(s) })
    return invoke<string[]>('db_docker_list_mysql', { ...target(s), ...creds(s) })
  }

  const listTables = (s: DbServer, db: string): Promise<string[]> => {
    if (isRedis(s)) return invoke<string[]>('db_docker_redis_keys', { ...target(s), db, password: s.password ?? '' })
    const cmd = isMongo(s) ? 'db_docker_mongo_collections' : sqlCmd(s, 'tables')
    return invoke<string[]>(cmd, { ...target(s), db, ...creds(s) })
  }

  const renderRedisValue = (db: string, key: string, v: { kind: string; value: string }): void => {
    const pre = document.createElement('pre')
    pre.className = 'db-doc'
    pre.textContent = v.value || i18nT('db.empty')
    const scroll = document.createElement('div')
    scroll.className = 'db-docs'
    scroll.appendChild(pre)
    showDetail(detailHead(`db${db} · ${key}`, v.kind), scroll)
  }

  const openData = async (s: DbServer, db: string, name: string): Promise<void> => {
    showDetail(note(i18nT('common.loading'), 'db-detail-loading'))
    try {
      if (isRedis(s)) {
        const v = await invoke<{ kind: string; value: string }>('db_docker_redis_value', { ...target(s), db, key: name, password: s.password ?? '' })
        renderRedisValue(db, name, v)
        return
      }
      if (isMongo(s)) {
        const docs = await invoke<string[]>('db_docker_mongo_docs', { ...target(s), db, collection: name, ...creds(s) })
        renderDocs(s, db, name, docs)
      } else {
        const [data, pk] = await Promise.all([
          invoke<TableData>(sqlCmd(s, 'rows'), { ...target(s), db, table: name, ...creds(s) }),
          invoke<string[]>(sqlCmd(s, 'pk'), { ...target(s), db, table: name, ...creds(s) }).catch(() => [] as string[]),
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
    // Send to the AI chat: the selection or, if there's none, the current view (table/docs).
    const askBtn = document.createElement('button')
    askBtn.className = 'db-action'
    askBtn.title = i18nT('common.sendToAiChat')
    askBtn.innerHTML = icon('chat')
    askBtn.addEventListener('click', () => {
      const selection = window.getSelection()?.toString().trim()
      const content = (selection || detail.textContent || '').slice(-12000)
      if (content.trim()) askAi(`Contexto — datos de BD (${path}):\n\n\`\`\`\n${content}\n\`\`\`\n\n`)
    })
    bar.append(p, c, askBtn)
    return bar
  }

  // ---- query editor (detects the DB type) ----
  // Render cap: a SELECT * over a wide JOIN yields hundreds of columns; painting
  // tens of thousands of cells at once freezes/crashes the WebView. We limit the DOM
  // (the full data is still there; this only bounds what gets drawn).
  const MAX_COLS = 60
  const MAX_ROWS = 200
  const renderResultTable = (data: TableData): HTMLElement => {
    if (!data.columns.length) return note(data.rows.length ? i18nT('db.ok') : i18nT('db.noResults'), 'db-detail-hint')
    const cols = data.columns.slice(0, MAX_COLS)
    const tbl = document.createElement('table')
    tbl.className = 'db-grid'
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    cols.forEach(col => { const th = document.createElement('th'); th.textContent = col; htr.appendChild(th) })
    thead.appendChild(htr)
    const tbody = document.createElement('tbody')
    data.rows.slice(0, MAX_ROWS).forEach(row => {
      const tr = document.createElement('tr')
      row.slice(0, MAX_COLS).forEach(cell => {
        const td = document.createElement('td')
        td.textContent = cell
        if (cell === 'NULL') td.classList.add('db-null')
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    })
    tbl.append(thead, tbody)

    const overflow: string[] = []
    if (data.columns.length > MAX_COLS) overflow.push(i18nT('db.columnsShown', { count: data.columns.length, shown: MAX_COLS }))
    if (data.rows.length > MAX_ROWS) overflow.push(i18nT('db.rowsShown', { count: data.rows.length, shown: MAX_ROWS }))
    if (!overflow.length) return tbl
    const wrap = document.createElement('div')
    wrap.append(note(i18nT('db.largeResult', { size: overflow.join(', ') }), 'db-detail-hint'), tbl)
    return wrap
  }

  const preResult = (out: string): HTMLElement => {
    const pre = document.createElement('pre')
    pre.className = 'db-doc'
    const text = out.trim()
    pre.textContent = text.length > 200000 ? i18nT('db.truncated', { text: text.slice(0, 200000) }) : text || i18nT('db.noOutput')
    return pre
  }

  // Quotes an identifier according to the engine. Postgres needs it for names
  // with uppercase letters (it lowercases them if unquoted); it also quotes each
  // part of `schema.table`. MySQL uses backticks.
  const qIdent = (s: DbServer, name: string): string =>
    isPg(s) ? name.split('.').map(p => `"${p}"`).join('.') : `\`${name}\``

  // Example query for a specific table/collection/key, depending on the type.
  const exampleQuery = (s: DbServer, name: string): string => {
    if (isMongo(s)) return `db.${name}.find().limit(20).toArray()`
    if (isRedis(s)) return `GET ${name}`
    return `SELECT * FROM ${qIdent(s, name)} LIMIT 100`
  }

  // Joins a table with ALL its related tables at once (a table can have several
  // FKs). SQL → multi-JOIN; Mongo → several $lookup stages.
  const buildRelationQuery = (s: DbServer, table: string, fks: ForeignKey[]): string => {
    if (isMongo(s)) {
      const stages = fks.map(fk =>
        `  { $lookup: { from: "${fk.ref_table}", localField: "${fk.column}", foreignField: "_id", as: "${fk.ref_table}" } }`)
      return `db.${table}.aggregate([\n${stages.join(',\n')},\n  { $limit: 20 }\n]).toArray()`
    }
    const joins = fks.map((fk, i) => {
      const alias = `r${i + 1}`
      return `JOIN ${qIdent(s, fk.ref_table)} ${alias} ON base.${qIdent(s, fk.column)} = ${alias}.${qIdent(s, fk.ref_column)}`
    })
    return `SELECT * FROM ${qIdent(s, table)} base\n${joins.join('\n')}\nLIMIT 100`
  }

  // Query from a JOIN plan (deterministic builder, no AI).
  const buildJoinQuery = (s: DbServer, plan: JoinPlan): string => {
    const aliasOf = new Map<string, string>([[plan.base, 't0']])
    let sql = `SELECT * FROM ${qIdent(s, plan.base)} t0`
    plan.steps.forEach((st, i) => {
      const a = `t${i + 1}`
      aliasOf.set(st.to, a)
      sql += `\nJOIN ${qIdent(s, st.to)} ${a} ON ${aliasOf.get(st.from)}.${qIdent(s, st.fromCol)} = ${a}.${qIdent(s, st.toCol)}`
    })
    return `${sql}\nLIMIT 100`
  }

  // Groups relations by source table: each table → all its FKs.
  const groupRelations = (rels: ForeignKey[]): Map<string, ForeignKey[]> => {
    const byTable = new Map<string, ForeignKey[]>()
    rels.forEach(fk => { byTable.set(fk.table, [...(byTable.get(fk.table) ?? []), fk]) })
    return byTable
  }

  // DB relations: FKs in SQL, heuristic references in Mongo, nothing in Redis.
  const fetchRelations = (s: DbServer, db: string): Promise<ForeignKey[]> => {
    if (isRedis(s)) return Promise.resolve([])
    const cmd = isMongo(s) ? 'db_docker_mongo_refs' : sqlCmd(s, 'fks')
    return invoke<ForeignKey[]>(cmd, { ...target(s), db, ...creds(s) }).catch(() => [] as ForeignKey[])
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

    // (B) Generate the query with AI: sends the schema (tables + relations) to the
    // chat and you describe in natural language what you want.
    const aiBtn = document.createElement('button')
    aiBtn.className = 'db-connect db-query-ai'
    aiBtn.textContent = i18nT('db.generateWithAi')
    aiBtn.addEventListener('click', async () => {
      const noun = isMongo(s) ? i18nT('db.collections') : i18nT('db.tables')
      const noun2 = isMongo(s) ? 'colecciones' : 'tablas'
      const rels = await relationsReady
      let schema = `Base de datos ${KIND_LABEL[s.kind]} "${db}".\n${noun}: ${names.join(', ')}.`
      // Inline relations only if there are few; with many, the AI requests them via the tool.
      if (rels.length && rels.length <= 50) {
        schema += `\nRelaciones (FK): ${rels.map(f => `${f.table}.${f.column} → ${f.ref_table}.${f.ref_column}`).join('; ')}.`
      }
      const dialect = isMongo(s)
        ? 'una consulta mongosh (usa $lookup para unir colecciones relacionadas)'
        : isRedis(s)
          ? 'un comando redis-cli'
          : isPg(s)
            ? 'una consulta SQL de PostgreSQL. IMPORTANTE: entrecomilla SIEMPRE los identificadores y CADA PARTE por separado: "esquema"."tabla" (NUNCA "esquema.tabla" con el punto dentro de las comillas). Ej.: FROM "public"."client"'
            : 'una consulta SQL'
      // The runner executes the query the AI writes against this DB. If it fails, it offers
      // "Fix with AI": resends the query + the error so the model corrects it.
      const runner: AiQueryRunner = async query => {
        try {
          return await executeQuery(query)
        } catch (e) {
          const err = String(e)
          const wrap = document.createElement('div')
          wrap.className = 'db-query-fix'
          wrap.append(note(err, 'db-detail-error'))
          const fixBtn = document.createElement('button')
          fixBtn.className = 'db-connect db-query-ai'
          fixBtn.textContent = i18nT('db.fixWithAi')
          fixBtn.addEventListener('click', () => askAi(
            `La consulta falló al ejecutarse. Corrígela (usa get_columns/get_relations si hace falta) y devuélvela lista para ejecutar.\n\nConsulta:\n${query}\n\nError:\n${err}`,
            true, runner, tools,
          ))
          wrap.append(fixBtn)
          return wrap
        }
      }
      // Tools: the AI requests real columns and relations on demand (scales with many tables).
      const arrayParam = (desc: string) => ({
        type: 'object',
        properties: { tables: { type: 'array', items: { type: 'string' }, description: desc } },
        required: ['tables'],
      })
      const tableDesc = `Nombres de ${noun2}${isPg(s) ? ' (formato schema.tabla)' : ''}`
      const tools: AiTool[] = isRedis(s) ? [] : [
        {
          name: 'get_columns',
          schema: { type: 'function', function: { name: 'get_columns', description: `Columnas reales (nombre y tipo) de las ${noun2} indicadas. Úsalo antes de escribir la consulta.`, parameters: arrayParam(tableDesc) } },
          run: async args => {
            const wanted = Array.isArray(args.tables) ? (args.tables as string[]).slice(0, 30) : []
            const parts = await Promise.all(wanted.map(async t => `${t}: ${(await getColumns(t)).join(', ') || '(desconocidas)'}`))
            return parts.join('\n') || '(sin columnas)'
          },
        },
        {
          name: 'get_relations',
          schema: { type: 'function', function: { name: 'get_relations', description: `Relaciones (claves foráneas) que tocan las ${noun2} indicadas: por qué columnas unirlas (JOIN${isMongo(s) ? '/$lookup' : ''}).`, parameters: arrayParam(tableDesc) } },
          run: async args => {
            const wanted = new Set(Array.isArray(args.tables) ? (args.tables as string[]) : [])
            const relevant = rels.filter(f => wanted.has(f.table) || wanted.has(f.ref_table))
            return relevant.map(f => `${f.table}.${f.column} → ${f.ref_table}.${f.ref_column}`).join('\n') || '(sin relaciones para esas tablas)'
          },
        },
      ]
      const verb = isMongo(s) ? 'etapas $lookup' : 'los JOIN'
      const fence = isMongo(s) ? '```js' : '```sql'
      const guide = tools.length
        ? ` Usa get_columns (columnas reales) y get_relations (claves foráneas) antes de responder. Une SOLO ${noun2} con una relación real (compruébalo con get_relations) y ordena ${verb} de modo que cada tabla referenciada ya se haya introducido antes. Si la petición implica varias ${noun2}, escribe la consulta COMPLETA; no te limites a un SELECT de una sola tabla. Devuelve SIEMPRE la consulta final dentro de un único bloque de código (${fence} … \`\`\`), sin indentarlo.`
        : ''
      askAi(`${schema}\n\nEscríbeme ${dialect} para: ${guide}`, false, runner, tools)
    })

    const actions = document.createElement('div')
    actions.className = 'db-query-actions'
    actions.append(runBtn, aiBtn)

    // Deterministic JOIN builder (no AI): you pick tables and Bento finds the
    // JOIN path through the foreign keys. SQL only.
    const joinBuilder = document.createElement('div')
    joinBuilder.className = 'db-join-builder'
    if (!isMongo(s) && !isRedis(s)) {
      const picked: string[] = []
      const jLabel = document.createElement('span')
      jLabel.className = 'db-query-examples-label'
      jLabel.textContent = i18nT('db.joinTables')
      const jChips = document.createElement('span')
      jChips.className = 'db-join-chips'
      const jAdd = document.createElement('input')
      jAdd.className = 'db-join-add'
      jAdd.placeholder = i18nT('db.addTable')
      const listId = `db-join-list-${++joinListSeq}`
      jAdd.setAttribute('list', listId)
      const jList = document.createElement('datalist')
      jList.id = listId
      names.forEach(n => { const o = document.createElement('option'); o.value = n; jList.appendChild(o) })
      const jBuild = document.createElement('button')
      jBuild.className = 'db-connect'
      jBuild.textContent = i18nT('db.buildJoin')
      const jMsg = document.createElement('span')
      jMsg.className = 'db-join-msg'

      const renderPicked = (): void => {
        jChips.replaceChildren()
        picked.forEach(t => {
          const c = document.createElement('button')
          c.className = 'db-query-chip db-query-chip-rel'
          c.textContent = `${t} ✕`
          c.title = i18nT('common.remove')
          c.addEventListener('click', () => { picked.splice(picked.indexOf(t), 1); renderPicked() })
          jChips.appendChild(c)
        })
      }
      jAdd.addEventListener('change', () => {
        const v = jAdd.value.trim()
        if (v && names.includes(v) && !picked.includes(v)) { picked.push(v); renderPicked() }
        jAdd.value = ''
      })
      jBuild.addEventListener('click', async () => {
        jMsg.textContent = ''
        if (!picked.length) return
        await relationsReady
        const rels: Relation[] = relations.map(f => ({ table: f.table, column: f.column, refTable: f.ref_table, refColumn: f.ref_column }))
        const plan = buildJoinPath(picked, rels)
        if (!plan) { jMsg.textContent = i18nT('db.thoseTablesAreNotConnectedByTheirRelationships'); return }
        editor.value = buildJoinQuery(s, plan)
        editor.focus()
      })
      joinBuilder.append(jLabel, jChips, jAdd, jList, jBuild, jMsg)
    }

    // Filtered search + group toggle. DATA-DRIVEN render with a CAP: a large DB
    // has thousands of tables/relations and painting them all as buttons (each
    // with a listener) froze the UI. We paint at most CHIP_CAP and the filter
    // re-renders the matches from the whole list.
    type Group = 'all' | 'table' | 'rel'
    interface ChipItem { group: 'table' | 'rel'; label: string; title: string; fill: () => string }
    const CHIP_CAP = 200
    let activeGroup: Group = 'all'
    const chipItems: ChipItem[] = names.map(name => ({
      group: 'table', label: name, title: i18nT('db.insertExampleQuery'), fill: () => exampleQuery(s, name),
    }))

    const filter = document.createElement('input')
    filter.className = 'db-query-filter'
    filter.placeholder = i18nT('db.filterTablesRelationships')
    filter.spellcheck = false

    const examples = document.createElement('div')
    examples.className = 'db-query-examples'

    const groupLabel = (g: 'table' | 'rel'): string =>
      g === 'rel' ? 'Relaciones:' : isRedis(s) ? 'Claves:' : isMongo(s) ? 'Colecciones:' : 'Tablas:'

    const renderChips = (): void => {
      const q = filter.value.trim().toLowerCase()
      const matches = chipItems.filter(it =>
        (activeGroup === 'all' || it.group === activeGroup) && (!q || it.label.toLowerCase().includes(q)))
      examples.replaceChildren()
      let lastGroup = ''
      matches.slice(0, CHIP_CAP).forEach(it => {
        if (it.group !== lastGroup) {
          lastGroup = it.group
          const lbl = document.createElement('span')
          lbl.className = 'db-query-examples-label'
          lbl.textContent = groupLabel(it.group)
          examples.appendChild(lbl)
        }
        const chip = document.createElement('button')
        chip.className = it.group === 'rel' ? 'db-query-chip db-query-chip-rel' : 'db-query-chip'
        chip.textContent = it.label
        chip.title = it.title
        chip.addEventListener('click', () => { editor.value = it.fill(); editor.focus() })
        examples.appendChild(chip)
      })
      if (matches.length > CHIP_CAP) {
        examples.appendChild(note(i18nT('db.moreResults', { count: matches.length - CHIP_CAP }), 'db-detail-hint'))
      }
    }
    filter.addEventListener('input', renderChips)

    const toggle = document.createElement('div')
    toggle.className = 'db-query-toggle'
    if (!isRedis(s)) {
      const groups: Array<[Group, string]> = [
        ['all', 'Todas'],
        ['table', isMongo(s) ? i18nT('db.collections') : i18nT('db.tables')],
        ['rel', 'Relaciones'],
      ]
      groups.forEach(([g, label]) => {
        const b = document.createElement('button')
        b.className = g === 'all' ? 'db-query-toggle-btn active' : 'db-query-toggle-btn'
        b.textContent = label
        b.addEventListener('click', () => {
          activeGroup = g
          toggle.querySelectorAll('.db-query-toggle-btn').forEach(x => x.classList.remove('active'))
          b.classList.add('active')
          renderChips()
        })
        toggle.appendChild(b)
      })
    }

    renderChips()

    // Relations (grouped by table) as additional items, after the FKs load.
    if (!isRedis(s)) {
      relationsReady.then(rels => {
        ;[...groupRelations(rels).entries()].forEach(([table, fks]) => {
          chipItems.push({
            group: 'rel',
            label: `${table} ▸ ${fks.map(f => f.ref_table).join(', ')}`,
            title: fks.map(f => `${f.table}.${f.column} → ${f.ref_table}.${f.ref_column}`).join('\n'),
            fill: () => buildRelationQuery(s, table, fks),
          })
        })
        renderChips()
      }).catch(() => {})
    }

    const bar = document.createElement('div')
    bar.className = 'db-query-bar'
    bar.append(editor, actions, joinBuilder, filter, toggle, examples)

    const resultArea = document.createElement('div')
    resultArea.className = 'db-grid-scroll'
    resultArea.append(note(i18nT('db.writeAQueryAndRunIt'), 'db-detail-hint'))

    // Postgres safety net: quotes known table names with uppercase letters if
    // they come unquoted (Postgres would lowercase them and fail). Covers what
    // the AI forgets to quote.
    const pgFixIdents = (sql: string): string => {
      let out = sql
      const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.forEach(full => {
        if (!full.includes('.')) return
        const quotedRight = full.split('.').map(p => `"${p}"`).join('.')
        // Wrongly quoted as a single piece: "schema.table" → "schema"."table".
        out = out.split(`"${full}"`).join(quotedRight)
      })
      names.forEach(full => {
        const table = full.includes('.') ? full.split('.').slice(-1)[0] : full
        if (!/[A-Z]/.test(table)) return // the rest is only at risk due to uppercase letters
        const quotedFull = full.split('.').map(p => `"${p}"`).join('.')
        out = out.replace(new RegExp(`(^|[^"\\w.])${esc(full)}(?![\\w"])`, 'g'), `$1${quotedFull}`)
        out = out.replace(new RegExp(`(^|[^"\\w.])${esc(table)}(?![\\w"])`, 'g'), `$1"${table}"`)
      })
      return out
    }

    // Real columns (name + type) of a table/collection, for the AI's get_columns
    // tool. Covers MySQL, MariaDB, PostgreSQL and Mongo.
    const sqlEsc = (v: string): string => v.replace(/'/g, "''")
    const getColumns = async (table: string): Promise<string[]> => {
      try {
        if (isMongo(s)) {
          const script = `Object.keys(db.getSiblingDB('${sqlEsc(db)}').getCollection('${sqlEsc(table)}').findOne()||{}).join('\\n')`
          const out = await invoke<string>('db_docker_mongo_query', { ...target(s), db, script, ...creds(s) })
          return out.split('\n').map(x => x.trim()).filter(Boolean)
        }
        if (isPg(s)) {
          const parts = table.split('.')
          const tbl = parts.pop() ?? table
          const schema = parts.pop() ?? 'public'
          const sql = `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='${sqlEsc(schema)}' AND table_name='${sqlEsc(tbl)}' ORDER BY ordinal_position`
          const data = await invoke<TableData>('db_docker_pg_query', { ...target(s), db, sql, ...creds(s) })
          return data.rows.map(r => `${r[0]} (${r[1]})`)
        }
        // MySQL / MariaDB (same client)
        const sql = `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${sqlEsc(db)}' AND TABLE_NAME='${sqlEsc(table)}' ORDER BY ORDINAL_POSITION`
        const data = await invoke<TableData>('db_docker_mysql_query', { ...target(s), db, sql, ...creds(s) })
        return data.rows.map(r => `${r[0]} (${r[1]})`)
      } catch {
        return []
      }
    }

    // Runs a query and returns the element with the result (table or text).
    // Reused by the editor and by the "Run" button in the AI chat.
    const executeQuery = async (text: string): Promise<HTMLElement> => {
      if (isMongo(s)) return preResult(await invoke<string>('db_docker_mongo_query', { ...target(s), db, script: text, ...creds(s) }))
      if (isRedis(s)) return preResult(await invoke<string>('db_docker_redis_command', { ...target(s), db, command: text, password: s.password ?? '' }))
      const limited = withRowLimit(text)
      // MySQL/MariaDB: with many tables the optimizer takes forever to find the
      // optimal JOIN ORDER (combinatorial explosion during PLANNING, even if the
      // query executes few rows). With depth=1 it plans greedily instantly.
      // Postgres doesn't suffer from this.
      const sql = isPg(s) ? pgFixIdents(limited) : `SET SESSION optimizer_search_depth=1; ${limited}`
      return renderResultTable(await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql, ...creds(s) }))
    }

    // EXPLAIN: asks the engine for the execution plan WITHOUT running the query. It's
    // instant and reveals why a query is slow: which table is scanned in full
    // (join type ALL, no index) and how many rows it estimates combining.
    const explain = async (text: string): Promise<HTMLElement> => {
      const raw = text.trim().replace(/;\s*$/, '')
      // With many tables, MySQL/MariaDB takes so long to PLAN the JOIN order that
      // even the EXPLAIN hangs. optimizer_search_depth=1 forces an immediate
      // greedy plan: the diagnostic returns instead of blowing up.
      const sql = isPg(s)
        ? `EXPLAIN ${pgFixIdents(raw)}`
        : `SET SESSION optimizer_search_depth=1; EXPLAIN ${raw}`
      const plan = renderResultTable(await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql, ...creds(s) }))
      const wrap = document.createElement('div')
      wrap.append(
        note(i18nT('db.executionPlanHighRowCountsOrTypeAll'), 'db-detail-hint'),
        plan,
      )
      return wrap
    }

    const run = async (): Promise<void> => {
      const text = editor.value.trim()
      if (!text) return
      resultArea.replaceChildren(note(i18nT('db.running'), 'db-detail-loading'))
      try {
        resultArea.replaceChildren(await executeQuery(text))
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
        await invoke(sqlCmd(s, 'update'), { ...target(s), db, table, column, value, wheres, ...creds(s) })
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
      await invoke(sqlCmd(s, 'delete'), { ...target(s), db, table, wheres, ...creds(s) })
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
      scroll.append(note(i18nT('db.noRows')))
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
          del.title = i18nT('db.deleteRow')
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
    const hint = editable ? i18nT('db.editHint') : i18nT('db.readOnlyHint')
    showDetail(detailHead(`${db}.${table}`, i18nT('db.rowsSummary', { count: data.rows.length, suffix: hint })), scroll)
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
    save.textContent = i18nT('common.save')
    const cancel = document.createElement('button')
    cancel.className = 'db-doc-cancel'
    cancel.textContent = i18nT('common.cancel')
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
      if (!confirm(i18nT('db.replaceTheDocumentById'))) return
      try {
        await invoke('db_docker_mongo_update', { ...target(s), db, collection: coll, doc: ta.value, ...creds(s) })
        restore(prettyJson(ta.value))
      } catch (e) {
        alert(String(e))
      }
    })
  }

  const deleteDoc = async (s: DbServer, db: string, coll: string, item: HTMLElement, current: string): Promise<void> => {
    if (!confirm(i18nT('db.deleteThisDocument'))) return
    try {
      await invoke('db_docker_mongo_delete', { ...target(s), db, collection: coll, doc: current, ...creds(s) })
      item.remove()
    } catch (e) {
      alert(String(e))
    }
  }

  const renderDocs = (s: DbServer, db: string, coll: string, docs: string[]): void => {
    const scroll = document.createElement('div')
    scroll.className = 'db-docs'
    if (!docs.length) {
      scroll.append(note(i18nT('db.noDocuments')))
    } else {
      docs.forEach(d => {
        const item = document.createElement('div')
        item.className = 'db-doc-item'
        const del = document.createElement('button')
        del.className = 'db-del db-doc-del'
        del.title = i18nT('db.deleteDocument')
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
    showDetail(detailHead(`${db}.${coll}`, i18nT('db.documentsSummary', { name: docs.length })), scroll)
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
      const queryRow = rowEl(2, 'scripts', 'Nueva consulta', false)
      queryRow.classList.add('db-leaf', 'db-query-leaf')
      queryRow.addEventListener('click', () => { selectLeaf(queryRow); openQuery(s, db, names) })
      container.appendChild(queryRow)
      if (!names.length) { container.append(note(i18nT('db.noTables'))); return }
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
