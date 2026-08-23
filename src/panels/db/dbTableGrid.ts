import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { icon } from '../../ui/icons'
import { parseStructuredJson } from './jsonValues'
import { sqlCmd, creds, target, type TableData } from '../../core/db/dbEngine'
import { buildJsonTree, renderCellValue } from './dbCellRender'
import { note, makeFilterInput, makeCsvBtn, makeResultWrap, copyToClipboard } from './dbWidgets'
import { editCell, deleteRow } from './dbRowEdit'
import { ident, qualifiedTable, quoteValue } from '../../core/db/sqlQuote'
import type { DbDetailHost } from './dbDetailHost'

export const renderGrid = (
  host: DbDetailHost, s: DbServer, db: string, table: string, data: TableData, pk: string[],
  fkColMap: Map<string, { ref_table: string; ref_column: string }>, onRefresh?: () => void,
): void => {
  const { showDetail, detailHead } = host
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
        void copyToClipboard(copyBtn2, JSON.stringify(obj, null, 2))
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
        const vals: Array<[string, string | null]> = []
        cellStates.forEach(({ input: inp, isNull }, i) => {
          if (isNull) vals.push([data.columns[i], null])
          else if (inp.value !== '') vals.push([data.columns[i], inp.value])
        })
        if (!vals.length) { alert(i18nT('db.insertNeedValue')); return }
        const colSql = vals.map(([c]) => ident(s, c)).join(', ')
        const valSql = vals.map(([, v]) => v === null ? 'NULL' : quoteValue(s, v)).join(', ')
        const tblQ = qualifiedTable(s, db, table)
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
