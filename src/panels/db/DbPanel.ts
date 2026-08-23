import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { parseDockerPs } from '../../core/db/dockerPs'
import { serverKind } from '../../core/db/serverKind'
import { publishedPort } from '../../core/db/hostPort'
import { mysqlCreds, mongoCreds, pgCreds } from '../../core/db/credentials'
import { DEFAULT_PORT, LISTABLE, kindForPort, type DbServer } from '../../core/db/dbServer'
import { icon } from '../../ui/icons'
import { askAi, type AiQueryRunner, type AiTool } from '../../ui/askAi'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import { buildJoinPath, type Relation } from '../../core/db/joinPath'
import { withRowLimit } from '../../core/db/rowLimit'
import { buildJoinQuery, buildRelationQuery, exampleQuery, groupRelations, type ForeignKey } from './queryBuilders'
import {
  KIND_LABEL, isMongo, isPg, isRedis, envValue, sqlCmd, creds, target,
  parseRedisLines, fetchColumns, listDatabases, listTables, fetchRelations,
  type TableData, type EditMeta,
} from './dbAccess'
import { parseStructuredJson } from './jsonValues'

// Counter for unique datalist ids (several DB panels/views at once).
let joinListSeq = 0
let closeOpenPanel: (() => void) | null = null

const note = (text: string, cls = 'db-note'): HTMLElement => {
  const el = document.createElement('div')
  el.className = cls
  el.textContent = text
  return el
}

const prettyJson = (json: string): string => {
  try { return JSON.stringify(JSON.parse(json), null, 2) } catch { return json }
}

const mkSpan = (cls: string, text: string): HTMLSpanElement => {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  return s
}

// Matches: key+colon | string value | number | true/false/null | punctuation
const JSON_TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g

const primitiveClass = (val: unknown): string => {
  if (typeof val === 'string') return 'js'
  if (typeof val === 'number') return 'jn'
  return 'jl'
}

const buildJsonTree = (val: unknown, depth: number): HTMLElement => {
  if (val === null || typeof val !== 'object') {
    return mkSpan(primitiveClass(val), JSON.stringify(val))
  }
  const isArr = Array.isArray(val)
  const entries: [string, unknown][] = isArr
    ? (val as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(val as Record<string, unknown>)
  const openB = isArr ? '[' : '{'
  const closeB = isArr ? ']' : '}'
  if (depth >= 6) return mkSpan('jt-hint', `${openB}…${entries.length}${closeB}`)
  const initialOpen = depth < 2

  const node = document.createElement('div')
  node.className = 'jt-node'

  const header = document.createElement('span')
  header.className = 'jt-header'
  const toggle = document.createElement('button')
  toggle.className = 'jt-toggle'
  toggle.textContent = initialOpen ? '▼' : '▶'
  const hint = document.createElement('span')
  hint.className = 'jt-hint'
  hint.textContent = `${entries.length}${closeB}`
  hint.style.display = initialOpen ? 'none' : 'inline'
  header.append(toggle, mkSpan('jp', openB), hint)

  const body = document.createElement('div')
  body.className = 'jt-body'
  body.style.display = initialOpen ? 'block' : 'none'
  entries.forEach(([key, childVal]) => {
    const row = document.createElement('div')
    row.className = 'jt-row'
    if (!isArr) {
      row.appendChild(mkSpan('jk', `"${key}"`))
      row.appendChild(document.createTextNode(': '))
    }
    row.appendChild(buildJsonTree(childVal, depth + 1))
    body.appendChild(row)
  })

  const close = document.createElement('span')
  close.className = 'jp jt-close'
  close.textContent = closeB
  close.style.display = initialOpen ? 'block' : 'none'

  toggle.addEventListener('click', e => {
    e.stopPropagation()
    const nowOpen = body.style.display === 'none'
    body.style.display = nowOpen ? 'block' : 'none'
    hint.style.display = nowOpen ? 'none' : 'inline'
    close.style.display = nowOpen ? 'block' : 'none'
    toggle.textContent = nowOpen ? '▼' : '▶'
  })

  node.append(header, body, close)
  return node
}

const highlightJson = (pre: HTMLPreElement, src: string): void => {
  const frag = document.createDocumentFragment()
  let cursor = 0
  let m: RegExpExecArray | null
  JSON_TOKEN_RE.lastIndex = 0
  while ((m = JSON_TOKEN_RE.exec(src)) !== null) {
    if (m.index > cursor) frag.appendChild(document.createTextNode(src.slice(cursor, m.index)))
    if (m[1] !== undefined) {
      frag.appendChild(mkSpan('jk', m[1]))
      frag.appendChild(document.createTextNode(m[2] ?? ''))
    } else if (m[3] !== undefined) {
      frag.appendChild(mkSpan('js', m[3]))
    } else if (m[4] !== undefined) {
      frag.appendChild(mkSpan('jn', m[4]))
    } else if (m[5] !== undefined) {
      frag.appendChild(mkSpan('jl', m[5]))
    } else if (m[6] !== undefined) {
      frag.appendChild(mkSpan('jp', m[6]))
    }
    cursor = m.index + m[0].length
  }
  if (cursor < src.length) frag.appendChild(document.createTextNode(src.slice(cursor)))
  pre.replaceChildren(frag)
}

const renderCellValue = (td: HTMLTableCellElement, value: string): void => {
  td.replaceChildren()
  td.classList.toggle('db-null', value === 'NULL')
  td.classList.remove('db-json-td')

  const json = parseStructuredJson(value)
  const isLongText = !json && (value.includes('\n') || value.length > 40 || value.endsWith('…'))

  if (!json && !isLongText) {
    td.textContent = value
    return
  }

  td.classList.add('db-json-td')
  const cell = document.createElement('div')
  cell.className = 'db-json-cell'
  const summaryEl = document.createElement('div')
  summaryEl.className = 'db-json-summary'

  const closeCell = (): void => {
    cell.classList.remove('db-json-open')
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown)
    closeOpenPanel = null
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (!cell.contains(e.target as Node)) closeCell()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeCell()
  }

  summaryEl.addEventListener('click', () => {
    const nowOpen = cell.classList.toggle('db-json-open')
    if (nowOpen) {
      closeOpenPanel?.()
      closeOpenPanel = closeCell
      document.addEventListener('pointerdown', onPointerDown)
      document.addEventListener('keydown', onKeyDown)
      requestAnimationFrame(() => {
        const rect = panel.getBoundingClientRect()
        panel.classList.toggle('db-json-flip', rect.bottom > window.innerHeight - 8)
      })
    } else {
      closeCell()
    }
  })

  if (json) {
    summaryEl.title = i18nT('db.expandJson')
    const badge = document.createElement('span')
    badge.className = 'db-json-badge'
    badge.textContent = i18nT('db.jsonBadge')
    const preview = document.createElement('span')
    preview.className = 'db-json-preview'
    preview.textContent = json.truncated
      ? i18nT('db.jsonTruncated')
      : json.kind === 'array'
        ? i18nT('db.jsonItems', { count: json.size })
        : i18nT('db.jsonKeys', { count: json.size })
    summaryEl.append(badge, preview)
  } else {
    const textPreview = document.createElement('span')
    textPreview.className = 'db-text-preview'
    textPreview.textContent = value.split('\n')[0].trim()
    summaryEl.appendChild(textPreview)
  }

  const rawContent = json ? json.formatted : value
  let contentEl: HTMLElement
  if (json && !json.truncated) {
    contentEl = document.createElement('div')
    contentEl.className = 'db-json-content'
    contentEl.appendChild(buildJsonTree(JSON.parse(json.formatted), 0))
  } else {
    contentEl = document.createElement('pre')
    contentEl.className = 'db-json-content'
    contentEl.textContent = rawContent
  }
  contentEl.addEventListener('dblclick', event => event.stopPropagation())

  const copyBtn = document.createElement('button')
  copyBtn.className = 'db-json-copy'
  copyBtn.title = i18nT('db.jsonCopy')
  copyBtn.textContent = '⎘'
  copyBtn.addEventListener('click', e => {
    e.stopPropagation()
    void navigator.clipboard.writeText(rawContent).then(() => {
      copyBtn.textContent = '✓'
      setTimeout(() => { copyBtn.textContent = '⎘' }, 1200)
    })
  })

  const panel = document.createElement('div')
  panel.className = 'db-json-panel'
  panel.append(copyBtn, contentEl)
  cell.append(summaryEl, panel)
  td.appendChild(cell)
}

const makeFilterInput = (onChange: (q: string) => void): HTMLInputElement => {
  const input = document.createElement('input')
  input.className = 'db-filter'
  input.placeholder = i18nT('db.filterRows')
  input.type = 'search'
  let t: ReturnType<typeof setTimeout> | null = null
  input.addEventListener('input', () => {
    if (t) clearTimeout(t)
    t = setTimeout(() => onChange(input.value.toLowerCase()), 150)
  })
  return input
}

const makeCsvBtn = (getData: () => { cols: string[]; rows: string[][]; filename: string }): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.className = 'db-action'
  btn.title = i18nT('db.exportCsv')
  btn.innerHTML = icon('download')
  btn.addEventListener('click', () => {
    const { cols, rows, filename } = getData()
    const csv = [cols, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  })
  return btn
}

const buildWheres = (pkIdx: number[], columns: string[], row: string[]): [string, string][] =>
  pkIdx.map(i => [columns[i], row[i]])

const makeResultWrap = (tbl: HTMLElement, toolbarItems: HTMLElement[]): HTMLElement => {
  const toolbar = document.createElement('div')
  toolbar.className = 'db-result-toolbar'
  toolbar.append(...toolbarItems)
  const wrap = document.createElement('div')
  wrap.className = 'db-result-wrap'
  wrap.append(toolbar, tbl)
  return wrap
}

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

  const renderRedisValue = (s: DbServer, db: string, key: string, v: { kind: string; value: string }, ttl: number): void => {
    const ttlLabel = ttl > 0 ? i18nT('db.ttlSeconds', { ttl }) : ttl === -1 ? i18nT('db.ttlPersists') : ''
    const kindStr = ttlLabel ? `${v.kind} · ${ttlLabel}` : v.kind
    const lines = v.value ? parseRedisLines(v.value) : []
    const rawValue = v.value || ''

    const buildContent = (): HTMLElement => {
      if (!v.value) return note(i18nT('db.empty'))

      if (v.kind === 'hash' && lines.length >= 2) {
        const tbl = document.createElement('table')
        tbl.className = 'db-redis-table'
        const thead = document.createElement('thead')
        const htr = document.createElement('tr')
        ;['Field', 'Value'].forEach(h => { const th = document.createElement('th'); th.textContent = h; htr.appendChild(th) })
        thead.appendChild(htr)
        const tbody = document.createElement('tbody')
        for (let i = 0; i < lines.length - 1; i += 2) {
          const field = lines[i], val = lines[i + 1]
          const tr = document.createElement('tr')
          const keyTd = document.createElement('td'); keyTd.textContent = field; tr.appendChild(keyTd)
          const valTd = document.createElement('td'); valTd.textContent = val
          valTd.classList.add('db-editable')
          valTd.addEventListener('dblclick', () => {
            const inp = document.createElement('input'); inp.className = 'db-cell-input'; inp.value = val
            valTd.replaceChildren(inp); inp.focus(); inp.select()
            let done = false
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur() } if (e.key === 'Escape') { done = true; valTd.textContent = val } })
            inp.addEventListener('blur', async () => {
              if (done) return; done = true
              if (inp.value === val) { valTd.textContent = val; return }
              try {
                await invoke('db_docker_redis_command', { ...target(s), db, command: `HSET ${key} ${field} ${inp.value}`, password: s.password ?? '' })
                valTd.textContent = inp.value
              } catch (e2) { alert(String(e2)); valTd.textContent = val }
            })
          })
          tr.appendChild(valTd); tbody.appendChild(tr)
        }
        tbl.append(thead, tbody); return tbl
      }

      if ((v.kind === 'list' || v.kind === 'set') && lines.length) {
        const ol = document.createElement('ol'); ol.className = 'db-redis-list'
        lines.forEach(item => { const li = document.createElement('li'); li.textContent = item; ol.appendChild(li) })
        return ol
      }

      if (v.kind === 'zset' && lines.length >= 2) {
        const tbl = document.createElement('table'); tbl.className = 'db-redis-table'
        const thead = document.createElement('thead'); const htr = document.createElement('tr')
        ;[i18nT('db.member'), i18nT('db.score')].forEach(h => { const th = document.createElement('th'); th.textContent = h; htr.appendChild(th) })
        thead.appendChild(htr); const tbody = document.createElement('tbody')
        for (let i = 0; i < lines.length - 1; i += 2) {
          const tr = document.createElement('tr')
          ;[lines[i], lines[i + 1]].forEach(v2 => { const td = document.createElement('td'); td.textContent = v2; tr.appendChild(td) })
          tbody.appendChild(tr)
        }
        tbl.append(thead, tbody); return tbl
      }

      // string / stream / unknown: existing behavior with optional editing
      const pre = document.createElement('pre'); pre.className = 'db-doc'
      const parsed = parseStructuredJson(rawValue)
      if (parsed && !parsed.truncated) highlightJson(pre, parsed.formatted)
      else pre.textContent = prettyJson(rawValue)

      if (v.kind === 'string') {
        pre.addEventListener('dblclick', () => {
          const ta = document.createElement('textarea'); ta.className = 'db-doc-edit'; ta.value = rawValue
          const acts = document.createElement('div'); acts.className = 'db-doc-actions'
          const saveBtn = document.createElement('button'); saveBtn.className = 'db-connect'; saveBtn.textContent = i18nT('common.save')
          const cancelBtn = document.createElement('button'); cancelBtn.className = 'db-doc-cancel'; cancelBtn.textContent = i18nT('common.cancel')
          acts.append(saveBtn, cancelBtn)
          const wrap = document.createElement('div'); wrap.className = 'db-doc-wrap'; wrap.append(ta, acts)
          pre.replaceWith(wrap); ta.focus()
          cancelBtn.addEventListener('click', () => wrap.replaceWith(pre))
          saveBtn.addEventListener('click', async () => {
            try {
              await invoke('db_docker_redis_set', { ...target(s), db, key, value: ta.value, password: s.password ?? '' })
              pre.textContent = ta.value; wrap.replaceWith(pre)
            } catch (e) { alert(String(e)) }
          })
        })
      }
      return pre
    }

    const content = buildContent()
    const copyBtn = document.createElement('button')
    copyBtn.className = 'db-action'; copyBtn.title = i18nT('db.jsonCopy'); copyBtn.textContent = '⎘'
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(rawValue).then(() => { copyBtn.textContent = '✓'; setTimeout(() => { copyBtn.textContent = '⎘' }, 1200) })
    })
    const toolbar = document.createElement('div'); toolbar.className = 'db-result-toolbar'; toolbar.appendChild(copyBtn)
    const scroll = document.createElement('div'); scroll.className = 'db-docs'; scroll.appendChild(content)
    showDetail(detailHead(`db${db} · ${key}`, kindStr), toolbar, scroll)
  }

  const openData = async (s: DbServer, db: string, name: string): Promise<void> => {
    showDetail(note(i18nT('common.loading'), 'db-detail-loading'))
    try {
      if (isRedis(s)) {
        const [v, ttl] = await Promise.all([
          invoke<{ kind: string; value: string }>('db_docker_redis_value', { ...target(s), db, key: name, password: s.password ?? '' }),
          invoke<number>('db_docker_redis_ttl', { ...target(s), db, key: name, password: s.password ?? '' }).catch(() => -2),
        ])
        renderRedisValue(s, db, name, v, ttl)
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
        const fkColMap = new Map<string, { ref_table: string; ref_column: string }>()
        fetchRelations(s, db).then(fks => {
          fks.filter(f => f.table === name).forEach(f => fkColMap.set(f.column, { ref_table: f.ref_table, ref_column: f.ref_column }))
        }).catch(() => {})
        renderGrid(s, db, name, data, pk, fkColMap, () => openData(s, db, name))
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
  const renderResultTable = (data: TableData, em?: EditMeta, loadMore?: (offset: number) => Promise<string[][]>): HTMLElement => {
    if (!data.columns.length) return note(data.rows.length ? i18nT('db.ok') : i18nT('db.noResults'), 'db-detail-hint')
    const cols = data.columns.slice(0, MAX_COLS)
    let sortCol = -1
    let sortDir: 'asc' | 'desc' = 'asc'
    let currentFilter = ''

    const tbl = document.createElement('table')
    tbl.className = 'db-grid'
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    cols.forEach((col, i) => {
      const th = document.createElement('th')
      th.textContent = col
      th.className = 'db-grid-th'
      th.addEventListener('click', () => {
        if (sortCol === i) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc'
        } else {
          sortCol = i; sortDir = 'asc'
        }
        htr.querySelectorAll('th').forEach((t, j) => {
          t.classList.toggle('db-sort-asc', j === sortCol && sortDir === 'asc')
          t.classList.toggle('db-sort-desc', j === sortCol && sortDir === 'desc')
        })
        renderRows()
      })
      htr.appendChild(th)
    })
    if (em?.pkIdx.length) htr.appendChild(document.createElement('th'))
    thead.appendChild(htr)
    const tbody = document.createElement('tbody')
    tbl.append(thead, tbody)

    const getSortedRows = (): string[][] => {
      let rows = data.rows
      if (sortCol >= 0) {
        rows = [...rows].sort((a, b) => {
          const av = a[sortCol] ?? '', bv = b[sortCol] ?? ''
          const an = parseFloat(av), bn = parseFloat(bv)
          const numeric = !isNaN(an) && !isNaN(bn) && av.trim() !== '' && bv.trim() !== ''
          const cmp = numeric ? an - bn : av.localeCompare(bv)
          return sortDir === 'asc' ? cmp : -cmp
        })
      }
      return currentFilter ? rows.filter(row => row.some(cell => cell.toLowerCase().includes(currentFilter))) : rows
    }

    const countEl = document.createElement('span')
    countEl.className = 'db-result-count'
    const total = data.rows.length

    const renderRows = (): void => {
      const rows = getSortedRows()
      countEl.textContent = currentFilter ? `${rows.length} / ${total}` : `${rows.length}`
      tbody.replaceChildren()
      rows.forEach(row => {
        const tr = document.createElement('tr')
        row.slice(0, MAX_COLS).forEach((cell, colIdx) => {
          const td = document.createElement('td')
          renderCellValue(td, cell)
          if (em) {
            td.classList.add('db-editable')
            td.addEventListener('dblclick', () =>
              editCell(em.s, em.db, em.table, data.columns, row, colIdx, em.pkIdx, td, em.fkColMap.get(data.columns[colIdx])))
          }
          tr.appendChild(td)
        })
        if (em?.pkIdx.length) {
          const actTd = document.createElement('td')
          actTd.className = 'db-row-actions'
          const del = document.createElement('button')
          del.className = 'db-del'
          del.title = i18nT('db.deleteRow')
          del.innerHTML = icon('trash')
          del.addEventListener('click', () => deleteRow(em.s, em.db, em.table, data.columns, row, em.pkIdx, tr, () => {
            const idx = data.rows.indexOf(row)
            if (idx >= 0) data.rows.splice(idx, 1)
            renderRows()
          }))
          actTd.appendChild(del)
          tr.appendChild(actTd)
        }
        tbody.appendChild(tr)
      })
    }

    const filterInput = makeFilterInput(q => { currentFilter = q; renderRows() })
    const csvBtn = makeCsvBtn(() => ({ cols, rows: getSortedRows().map(r => r.slice(0, MAX_COLS)), filename: 'result.csv' }))
    renderRows()

    const overflow: string[] = []
    if (data.columns.length > MAX_COLS) overflow.push(i18nT('db.columnsShown', { count: data.columns.length, shown: MAX_COLS }))

    const wrap = makeResultWrap(tbl, [filterInput, countEl, csvBtn])
    if (overflow.length) wrap.prepend(note(i18nT('db.largeResult', { size: overflow.join(', ') }), 'db-detail-hint'))

    if (loadMore && data.rows.length >= MAX_ROWS) {
      const loadBtn = document.createElement('button')
      loadBtn.className = 'db-load-more'
      loadBtn.textContent = i18nT('db.loadMore')
      loadBtn.addEventListener('click', async () => {
        loadBtn.disabled = true
        loadBtn.textContent = i18nT('common.loading')
        try {
          const more = await loadMore(data.rows.length)
          if (!more.length) { loadBtn.remove(); return }
          data.rows.push(...more)
          countEl.textContent = `${data.rows.length}`
          renderRows()
          if (more.length < MAX_ROWS) loadBtn.remove()
          else { loadBtn.disabled = false; loadBtn.textContent = i18nT('db.loadMore') }
        } catch (e) {
          loadBtn.disabled = false
          loadBtn.textContent = i18nT('db.loadMore')
          alert(String(e))
        }
      })
      wrap.appendChild(loadBtn)
    }

    return wrap
  }

  const preResult = (out: string): HTMLElement => {
    const pre = document.createElement('pre')
    pre.className = 'db-doc'
    const text = out.trim()
    pre.textContent = text.length > 200000 ? i18nT('db.truncated', { text: text.slice(0, 200000) }) : text || i18nT('db.noOutput')
    return pre
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
            const parts = await Promise.all(wanted.map(async t => `${t}: ${(await fetchColumns(s, db, t)).join(', ') || '(desconocidas)'}`))
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

    const histBtn = document.createElement('button')
    histBtn.className = 'db-connect'
    histBtn.title = i18nT('db.queryHistory')
    histBtn.textContent = '⏱'
    const histDrop = document.createElement('div')
    histDrop.className = 'db-hist-drop hidden'
    let offHistClick: (() => void) | null = null
    histBtn.addEventListener('click', e => {
      e.stopPropagation()
      if (offHistClick) { document.removeEventListener('click', offHistClick); offHistClick = null }
      const h = getHistory()
      histDrop.replaceChildren()
      if (!h.length) {
        histDrop.append(note(i18nT('db.noHistory'), 'db-detail-hint'))
      } else {
        h.forEach(q => {
          const btn = document.createElement('button')
          btn.className = 'db-hist-item'
          btn.textContent = q.split('\n')[0].slice(0, 80)
          btn.title = q
          btn.addEventListener('click', () => { editor.value = q; histDrop.classList.add('hidden'); editor.focus() })
          histDrop.appendChild(btn)
        })
      }
      histDrop.classList.toggle('hidden')
      if (!histDrop.classList.contains('hidden')) {
        offHistClick = (): void => { histDrop.classList.add('hidden'); offHistClick = null }
        setTimeout(() => { if (offHistClick) document.addEventListener('click', offHistClick, { once: true }) }, 0)
      }
    })
    const histWrap = document.createElement('div')
    histWrap.className = 'db-hist-wrap'
    histWrap.append(histBtn, histDrop)

    const actions = document.createElement('div')
    actions.className = 'db-query-actions'
    actions.append(runBtn, aiBtn, histWrap)

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
      g === 'rel' ? i18nT('db.relationsLabel') : isRedis(s) ? i18nT('db.keysLabel') : isMongo(s) ? i18nT('db.collectionsLabel') : i18nT('db.tablesLabel')

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
        ['all', i18nT('db.allGroup')],
        ['table', isMongo(s) ? i18nT('db.collections') : i18nT('db.tables')],
        ['rel', i18nT('db.relationsLabel')],
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

    const HIST_KEY = `bento.db.qhist.${s.kind}.${db}`
    const getHistory = (): string[] => { try { return JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]') as string[] } catch { return [] } }
    const saveHistory = (q: string): void => {
      const h = [q, ...getHistory().filter(x => x !== q)].slice(0, 20)
      localStorage.setItem(HIST_KEY, JSON.stringify(h))
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
      const data = await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql, ...creds(s) })

      // Enable editing when the query is a plain SELECT * FROM <table> with no joins or aggregations.
      // Pagination: offer "load more" when the query had no explicit LIMIT (withRowLimit added one).
      const trimmedText = text.trim().replace(/;\s*$/, '')
      const limitWasAdded = !/\blimit\b\s+\d/i.test(trimmedText) && /^(select|with)\b/i.test(trimmedText)
      const loadMore = limitWasAdded
        ? async (offset: number): Promise<string[][]> => {
            const pageSql = `${trimmedText} LIMIT 200 OFFSET ${offset}`
            const moreSql = isPg(s) ? pgFixIdents(pageSql) : `SET SESSION optimizer_search_depth=1; ${pageSql}`
            const more = await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql: moreSql, ...creds(s) })
            return more.rows
          }
        : undefined

      const simpleMatch = /^\s*select\s+\*\s+from\s+((?:"[^"]+"\."[^"]+"|"[^"]+"|`[^`]+`|\w+(?:\.\w+)*))\s*(?:limit\s+\d+\s*)?;?\s*$/i.exec(text.trim())
      if (simpleMatch) {
        const rawTable = simpleMatch[1].replace(/["'`]/g, '')
        const matched = names.find(n => n === rawTable || n.split('.').pop() === rawTable.split('.').pop())
        if (matched) {
          try {
            const [pk, allFks] = await Promise.all([
              invoke<string[]>(sqlCmd(s, 'pk'), { ...target(s), db, table: matched, ...creds(s) }).catch(() => [] as string[]),
              relationsReady.catch(() => [] as ForeignKey[]),
            ])
            const pkIdx = pk.map(c => data.columns.indexOf(c)).filter(i => i >= 0)
            const fkColMap = new Map<string, { ref_table: string; ref_column: string }>()
            allFks.filter(f => f.table === matched).forEach(f => fkColMap.set(f.column, { ref_table: f.ref_table, ref_column: f.ref_column }))
            return renderResultTable(data, { s, db, table: matched, pkIdx, fkColMap }, loadMore)
          } catch { /* fall through to read-only */ }
        }
      }

      return renderResultTable(data, undefined, loadMore)
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
        const result = await executeQuery(text)
        saveHistory(text)
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

  const editCell = (
    s: DbServer, db: string, table: string, columns: string[],
    row: string[], colIdx: number, pkIdx: number[], td: HTMLElement,
    fkRef?: { ref_table: string; ref_column: string },
  ): void => {
    const column = columns[colIdx]
    const old = row[colIdx]
    const restore = (): void => { renderCellValue(td as HTMLTableCellElement, old) }

    const applyUpdate = async (value: string, setNull = false): Promise<void> => {
      const wheres = buildWheres(pkIdx, columns, row)
      const summary = setNull
        ? `UPDATE ${table}\nSET ${column} = NULL\nWHERE ${wheres.map(([c, v]) => `${c}=${v}`).join(' AND ')}`
        : `UPDATE ${table}\nSET ${column} = '${value}'\nWHERE ${wheres.map(([c, v]) => `${c}=${v}`).join(' AND ')}`
      if (!confirm(summary)) { restore(); return }
      try {
        if (setNull) {
          const ident = (id: string): string => isPg(s) ? `"${id}"` : `\`${id}\``
          const w = wheres.map(([c, v]) => `${ident(c)} = '${v.replace(/'/g, "''")}'`).join(' AND ')
          const tblQ = isPg(s)
            ? table.split('.').map(p => `"${p}"`).join('.')
            : `\`${db}\`.\`${table}\``
          await invoke(sqlCmd(s, 'query'), { ...target(s), db, sql: `UPDATE ${tblQ} SET ${ident(column)} = NULL WHERE ${w}`, ...creds(s) })
          row[colIdx] = 'NULL'
          renderCellValue(td as HTMLTableCellElement, 'NULL')
          return
        }
        await invoke(sqlCmd(s, 'update'), { ...target(s), db, table, column, value, wheres, ...creds(s) })
        row[colIdx] = value
        renderCellValue(td as HTMLTableCellElement, value)
      } catch (e) {
        const err = String(e)
        const isFk = /foreign key/i.test(err)
        if (isFk && !isPg(s)) {
          if (!confirm(i18nT('db.fkBypass'))) { restore(); return }
          try {
            const q = value.replace(/'/g, "''")
            const w = wheres.map(([c, v]) => `\`${c}\` = '${v.replace(/'/g, "''")}'`).join(' AND ')
            await invoke(sqlCmd(s, 'query'), { ...target(s), db, sql: `SET FOREIGN_KEY_CHECKS=0; UPDATE \`${table}\` SET \`${column}\` = '${q}' WHERE ${w}; SET FOREIGN_KEY_CHECKS=1`, ...creds(s) })
            row[colIdx] = value
            renderCellValue(td as HTMLTableCellElement, value)
          } catch (e2) { alert(String(e2)); restore() }
        } else {
          alert(isFk ? i18nT('db.fkError') : err)
          restore()
        }
      }
    }

    if (fkRef) {
      td.replaceChildren(document.createTextNode('…'))
      void invoke<TableData>(sqlCmd(s, 'rows'), { ...target(s), db, table: fkRef.ref_table, ...creds(s) })
        .then(refData => {
          const refColIdx = refData.columns.indexOf(fkRef.ref_column)
          if (refColIdx < 0) { showInput(); return }
          const sel = document.createElement('select')
          sel.className = 'db-cell-input'
          refData.rows.forEach(r => {
            const o = document.createElement('option')
            o.value = r[refColIdx]
            const lbl = r.slice(0, 3).join(' · ')
            o.textContent = lbl.length > 60 ? lbl.slice(0, 57) + '…' : lbl
            if (r[refColIdx] === old) o.selected = true
            sel.appendChild(o)
          })
          td.replaceChildren(sel)
          sel.focus()
          let done = false
          sel.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); sel.blur() }
            if (e.key === 'Escape') { done = true; restore() }
          })
          sel.addEventListener('blur', () => {
            if (done) return
            done = true
            if (sel.value !== old) void applyUpdate(sel.value)
            else restore()
          })
        })
        .catch(showInput)
      return
    }

    showInput()

    function showInput(): void {
      const input = document.createElement('input')
      input.className = 'db-cell-input'
      input.value = old === 'NULL' ? '' : old
      const nullBtn = document.createElement('button')
      nullBtn.className = 'db-null-btn'
      nullBtn.textContent = 'NULL'
      nullBtn.title = i18nT('db.setNull')
      const wrap = document.createElement('div')
      wrap.className = 'db-cell-edit-wrap'
      wrap.append(input, nullBtn)
      td.replaceChildren(wrap)
      input.focus()
      input.select()
      let done = false
      nullBtn.addEventListener('mousedown', e => {
        e.preventDefault()
        done = true
        void applyUpdate('', true)
      })
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur() }
        else if (e.key === 'Escape') { done = true; restore() }
        else if (e.key === 'Tab') {
          e.preventDefault()
          const forward = !e.shiftKey
          input.blur()
          requestAnimationFrame(() => {
            const tr = td.closest('tr')!
            const tdsInRow = Array.from(tr.querySelectorAll('td[tabindex]')) as HTMLElement[]
            ;(tdsInRow[tdsInRow.indexOf(td) + (forward ? 1 : -1)] as HTMLElement | undefined)?.focus()
          })
        }
      })
      input.addEventListener('blur', () => {
        if (done) return
        done = true
        if (input.value === old) { restore(); return }
        void applyUpdate(input.value)
      })
    }
  }

  const deleteRow = async (
    s: DbServer, db: string, table: string, columns: string[],
    row: string[], pkIdx: number[], tr: HTMLElement,
    onDeleted?: () => void,
  ): Promise<void> => {
    const wheres = buildWheres(pkIdx, columns, row)
    if (!confirm(`DELETE FROM ${table}\nWHERE ${wheres.map(([c, v]) => `${c}=${v}`).join(' AND ')}`)) return
    try {
      await invoke(sqlCmd(s, 'delete'), { ...target(s), db, table, wheres, ...creds(s) })
      if (onDeleted) onDeleted()
      else tr.remove()
    } catch (e) {
      alert(String(e))
    }
  }

  const renderGrid = (s: DbServer, db: string, table: string, data: TableData, pk: string[], fkColMap: Map<string, { ref_table: string; ref_column: string }>, onRefresh?: () => void): void => {
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
      let sortCol = -1
      let sortDir: 'asc' | 'desc' = 'asc'

      data.columns.forEach((col, i) => {
        const th = document.createElement('th')
        th.textContent = col
        th.className = 'db-grid-th'
        th.addEventListener('click', () => {
          if (sortCol === i) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc'
          } else {
            sortCol = i; sortDir = 'asc'
          }
          htr.querySelectorAll('th').forEach((t, j) => {
            t.classList.toggle('db-sort-asc', j === sortCol && sortDir === 'asc')
            t.classList.toggle('db-sort-desc', j === sortCol && sortDir === 'desc')
          })
          sortRows()
        })
        htr.appendChild(th)
      })
      htr.appendChild(document.createElement('th'))
      thead.appendChild(htr)
      const tbody = document.createElement('tbody')
      const rowEls: Array<{ tr: HTMLTableRowElement; cells: string[] }> = []

      const showRowDetail = (row: string[]): void => {
        const overlay = document.createElement('div'); overlay.className = 'db-row-modal'
        const panel = document.createElement('div'); panel.className = 'db-row-modal-panel'
        const head = document.createElement('div'); head.className = 'db-row-modal-head'
        const title = document.createElement('span'); title.textContent = table
        const closeBtn = document.createElement('button'); closeBtn.className = 'db-action'; closeBtn.innerHTML = icon('x')
        closeBtn.addEventListener('click', () => overlay.remove())
        head.append(title, closeBtn)
        const body = document.createElement('div'); body.className = 'db-row-modal-body'
        data.columns.forEach((col, i) => {
          const val = row[i]
          const rowDiv = document.createElement('div'); rowDiv.className = 'db-row-modal-row'
          const keyEl = document.createElement('span'); keyEl.className = 'db-row-modal-key'; keyEl.textContent = col
          const valEl = document.createElement('div'); valEl.className = 'db-row-modal-val'
          const json = parseStructuredJson(val)
          if (json && !json.truncated) valEl.appendChild(buildJsonTree(JSON.parse(json.formatted), 0))
          else if (val === 'NULL') { const s2 = document.createElement('span'); s2.className = 'db-null'; s2.textContent = 'NULL'; valEl.appendChild(s2) }
          else valEl.textContent = val
          rowDiv.append(keyEl, valEl); body.appendChild(rowDiv)
        })
        panel.append(head, body); overlay.appendChild(panel); document.body.appendChild(overlay)
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
        const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc) } }
        document.addEventListener('keydown', onEsc)
      }

      data.rows.forEach(row => {
        const tr = document.createElement('tr')
        row.forEach((cell, colIdx) => {
          const td = document.createElement('td')
          renderCellValue(td, cell)
          if (editable) {
            td.classList.add('db-editable')
            td.setAttribute('tabIndex', '0')
            td.addEventListener('dblclick', () =>
              editCell(s, db, table, data.columns, row, colIdx, pkIdx, td, fkColMap.get(data.columns[colIdx])))
            td.addEventListener('keydown', e => {
              if (e.key === 'Enter') { e.preventDefault(); editCell(s, db, table, data.columns, row, colIdx, pkIdx, td, fkColMap.get(data.columns[colIdx])) }
              const tds = Array.from(tr.querySelectorAll('td[tabindex]')) as HTMLElement[]
              const ti = tds.indexOf(td)
              const trs = Array.from(tbody.children) as HTMLElement[]
              const ri = trs.indexOf(tr)
              if (e.key === 'ArrowRight') { e.preventDefault(); tds[ti + 1]?.focus() }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); tds[ti - 1]?.focus() }
              else if (e.key === 'ArrowDown') { e.preventDefault(); ;(trs[ri + 1]?.querySelectorAll('td[tabindex]')[ti] as HTMLElement | undefined)?.focus() }
              else if (e.key === 'ArrowUp') { e.preventDefault(); ;(trs[ri - 1]?.querySelectorAll('td[tabindex]')[ti] as HTMLElement | undefined)?.focus() }
            })
          }
          tr.appendChild(td)
        })
        const actions = document.createElement('td'); actions.className = 'db-row-actions'
        const detailBtn = document.createElement('button'); detailBtn.className = 'db-del'; detailBtn.title = i18nT('db.rowDetail'); detailBtn.innerHTML = icon('eye')
        detailBtn.addEventListener('click', () => showRowDetail(row)); actions.appendChild(detailBtn)
        const copyBtn2 = document.createElement('button'); copyBtn2.className = 'db-del'; copyBtn2.title = i18nT('db.copyRow'); copyBtn2.innerHTML = icon('copy')
        copyBtn2.addEventListener('click', () => {
          const obj: Record<string, string> = {}
          data.columns.forEach((col, i) => { obj[col] = row[i] })
          void navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(() => { copyBtn2.innerHTML = '✓'; setTimeout(() => { copyBtn2.innerHTML = icon('copy') }, 1200) })
        })
        actions.appendChild(copyBtn2)
        if (editable) {
          const del = document.createElement('button'); del.className = 'db-del'; del.title = i18nT('db.deleteRow'); del.innerHTML = icon('trash')
          del.addEventListener('click', () => deleteRow(s, db, table, data.columns, row, pkIdx, tr))
          actions.appendChild(del)
        }
        tr.appendChild(actions)
        rowEls.push({ tr, cells: row })
        tbody.appendChild(tr)
      })
      tbl.append(thead, tbody)

      const sortRows = (): void => {
        if (sortCol < 0) return
        const sorted = [...rowEls].sort((a, b) => {
          const av = a.cells[sortCol] ?? ''
          const bv = b.cells[sortCol] ?? ''
          const an = parseFloat(av), bn = parseFloat(bv)
          const numeric = !isNaN(an) && !isNaN(bn) && av.trim() !== '' && bv.trim() !== ''
          const cmp = numeric ? an - bn : av.localeCompare(bv)
          return sortDir === 'asc' ? cmp : -cmp
        })
        sorted.forEach(({ tr }) => tbody.appendChild(tr))
      }

      const countEl = document.createElement('span')
      countEl.className = 'db-result-count'
      countEl.textContent = `${data.rows.length}`

      const filterInput = makeFilterInput(q => {
        let visible = 0
        rowEls.forEach(({ tr, cells }) => {
          const show = !q || cells.some(c => c.toLowerCase().includes(q))
          tr.style.display = show ? '' : 'none'
          if (show) visible++
        })
        countEl.textContent = q ? `${visible} / ${data.rows.length}` : `${data.rows.length}`
      })
      const csvBtn = makeCsvBtn(() => ({
        cols: data.columns,
        rows: rowEls.filter(({ tr }) => tr.style.display !== 'none').map(({ cells }) => cells),
        filename: `${table}.csv`,
      }))

      const showInsertRow = (): void => {
        tbody.querySelector('.db-insert-row')?.remove()
        const itr = document.createElement('tr')
        itr.className = 'db-insert-row'
        const cellStates: Array<{ input: HTMLInputElement; isNull: boolean }> = []
        data.columns.forEach(col => {
          const td = document.createElement('td')
          const input = document.createElement('input')
          input.className = 'db-cell-input'
          input.placeholder = col
          const state = { input, isNull: false }
          cellStates.push(state)
          const nullBtn = document.createElement('button')
          nullBtn.className = 'db-null-btn'
          nullBtn.textContent = 'NULL'
          nullBtn.addEventListener('click', () => {
            state.isNull = !state.isNull
            nullBtn.classList.toggle('db-null-active', state.isNull)
            input.disabled = state.isNull
            input.value = state.isNull ? '' : input.value
          })
          const wrap = document.createElement('div')
          wrap.className = 'db-cell-edit-wrap'
          wrap.append(input, nullBtn)
          td.appendChild(wrap)
          itr.appendChild(td)
        })
        const actTd = document.createElement('td')
        actTd.className = 'db-row-actions'
        const okBtn = document.createElement('button')
        okBtn.className = 'db-connect'
        okBtn.textContent = '✓'
        okBtn.title = i18nT('db.insertRow')
        okBtn.addEventListener('click', async () => {
          const ident = (id: string): string => isPg(s) ? `"${id}"` : `\`${id}\``
          const quote = (v: string): string => isPg(s)
            ? `'${v.replace(/'/g, "''")}'`
            : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
          const vals: Array<[string, string | null]> = []
          cellStates.forEach(({ input: inp, isNull }, i) => {
            if (isNull) vals.push([data.columns[i], null])
            else if (inp.value !== '') vals.push([data.columns[i], inp.value])
          })
          if (!vals.length) { alert(i18nT('db.insertNeedValue')); return }
          const colSql = vals.map(([c]) => ident(c)).join(', ')
          const valSql = vals.map(([, v]) => v === null ? 'NULL' : quote(v)).join(', ')
          const tblQ = isPg(s)
            ? table.split('.').map(p => `"${p}"`).join('.')
            : `\`${db}\`.\`${table}\``
          okBtn.disabled = true
          try {
            await invoke(sqlCmd(s, 'query'), { ...target(s), db, sql: `INSERT INTO ${tblQ} (${colSql}) VALUES (${valSql})`, ...creds(s) })
            onRefresh?.()
          } catch (e) { okBtn.disabled = false; alert(String(e)) }
        })
        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'db-doc-cancel'
        cancelBtn.textContent = '✕'
        cancelBtn.addEventListener('click', () => itr.remove())
        actTd.append(okBtn, cancelBtn)
        itr.appendChild(actTd)
        tbody.appendChild(itr)
        cellStates[0]?.input.focus()
      }

      const toolbarItems: HTMLElement[] = [filterInput, countEl, csvBtn]
      if (onRefresh) {
        const refreshBtn = document.createElement('button')
        refreshBtn.className = 'db-action'
        refreshBtn.title = i18nT('common.refresh')
        refreshBtn.innerHTML = icon('refresh')
        refreshBtn.addEventListener('click', onRefresh)
        toolbarItems.push(refreshBtn)
      }
      if (editable && onRefresh) {
        const addBtn = document.createElement('button')
        addBtn.className = 'db-action'
        addBtn.title = i18nT('db.insertRow')
        addBtn.innerHTML = icon('plus')
        addBtn.addEventListener('click', showInsertRow)
        toolbarItems.push(addBtn)
      }
      scroll.appendChild(makeResultWrap(tbl, toolbarItems))
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
    const restore = (text: string): void => { wrap.replaceWith(makeDocPre(s, db, coll, text)) }
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

  const makeDocPre = (s: DbServer, db: string, coll: string, text: string): HTMLPreElement => {
    const pre = document.createElement('pre')
    pre.className = 'db-doc'
    pre.textContent = text
    pre.addEventListener('dblclick', () => editDoc(s, db, coll, pre))
    return pre
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

    const addNewDocRow = (): void => {
      scroll.querySelector('.db-new-doc-wrap')?.remove()
      const ta = document.createElement('textarea'); ta.className = 'db-doc-edit'; ta.value = '{\n  \n}'
      const acts = document.createElement('div'); acts.className = 'db-doc-actions'
      const saveBtn = document.createElement('button'); saveBtn.className = 'db-connect'; saveBtn.textContent = i18nT('common.save')
      const cancelBtn = document.createElement('button'); cancelBtn.className = 'db-doc-cancel'; cancelBtn.textContent = i18nT('common.cancel')
      acts.append(saveBtn, cancelBtn)
      const wrap = document.createElement('div'); wrap.className = 'db-doc-wrap db-new-doc-wrap'; wrap.append(ta, acts)
      scroll.prepend(wrap); ta.focus()
      cancelBtn.addEventListener('click', () => wrap.remove())
      saveBtn.addEventListener('click', async () => {
        try {
          const esc = (v: string): string => v.replace(/'/g, "\\'")
          await invoke<string>('db_docker_mongo_query', { ...target(s), db, script: `db.getSiblingDB('${esc(db)}').getCollection('${esc(coll)}').insertOne(${ta.value})`, ...creds(s) })
          wrap.remove()
          const fresh = await invoke<string[]>('db_docker_mongo_docs', { ...target(s), db, collection: coll, ...creds(s) })
          renderDocs(s, db, coll, fresh)
        } catch (e) { alert(String(e)) }
      })
    }

    const items: Array<{ el: HTMLElement; text: string }> = []
    const DOCS_PAGE = 20
    let docsShown = 0

    const addDocBatch = (): void => {
      scroll.querySelector('.db-load-more')?.remove()
      docs.slice(docsShown, docsShown + DOCS_PAGE).forEach(d => {
        const item = document.createElement('div'); item.className = 'db-doc-item'
        const del = document.createElement('button'); del.className = 'db-del db-doc-del'
        del.title = i18nT('db.deleteDocument'); del.innerHTML = icon('trash')
        del.addEventListener('click', () => deleteDoc(s, db, coll, item, item.querySelector('.db-doc')?.textContent ?? prettyJson(d)))
        const pre = makeDocPre(s, db, coll, prettyJson(d))
        item.append(del, pre); scroll.appendChild(item)
        items.push({ el: item, text: prettyJson(d).toLowerCase() })
      })
      docsShown += DOCS_PAGE
      if (docsShown < docs.length) {
        const btn = document.createElement('button'); btn.className = 'db-load-more'
        btn.textContent = i18nT('db.loadMore'); btn.addEventListener('click', addDocBatch)
        scroll.appendChild(btn)
      }
    }

    if (!docs.length) scroll.append(note(i18nT('db.noDocuments')))
    else addDocBatch()

    const addBtn = document.createElement('button'); addBtn.className = 'db-action'; addBtn.title = i18nT('db.newDoc'); addBtn.innerHTML = icon('plus')
    addBtn.addEventListener('click', addNewDocRow)
    const filterInput = makeFilterInput(q => {
      items.forEach(({ el, text }) => { el.style.display = !q || text.includes(q) ? '' : 'none' })
    })
    filterInput.placeholder = i18nT('db.filterDocs')
    const toolbar = document.createElement('div'); toolbar.className = 'db-result-toolbar'
    toolbar.append(addBtn, filterInput)
    showDetail(detailHead(`${db}.${coll}`, i18nT('db.documentsSummary', { name: docs.length })), toolbar, scroll)
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
    let children: HTMLElement | null = null
    let loaded = false
    row.addEventListener('click', () => {
      if (!children) {
        children = document.createElement('div')
        children.className = 'db-children'
        row.insertAdjacentElement('afterend', children)
        row.classList.add('open')
        if (!loaded) { loaded = true; onFirstExpand(children) }
        return
      }
      const willOpen = children.classList.contains('hidden')
      row.classList.toggle('open', willOpen)
      children.classList.toggle('hidden', !willOpen)
      if (willOpen && !loaded) { loaded = true; onFirstExpand(children) }
    })
    parent.appendChild(row)
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
