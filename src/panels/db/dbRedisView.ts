import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { parseStructuredJson } from '../../core/db/jsonValues'
import { target, parseRedisLines } from '../../core/db/dbEngine'
import { prettyJson, highlightJson } from './dbCellRender'
import { note, copyToClipboard } from './dbWidgets'
import type { DbDetailHost } from './dbDetailHost'

export const renderRedisValue = (
  host: DbDetailHost, s: DbServer, db: string, key: string,
  v: { kind: string; value: string }, ttl: number,
): void => {
  const { showDetail, detailHead } = host
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
  copyBtn.addEventListener('click', () => { void copyToClipboard(copyBtn, rawValue) })
  const toolbar = document.createElement('div'); toolbar.className = 'db-result-toolbar'; toolbar.appendChild(copyBtn)
  const scroll = document.createElement('div'); scroll.className = 'db-docs'; scroll.appendChild(content)
  showDetail(detailHead(`db${db} · ${key}`, kindStr), toolbar, scroll)
}
