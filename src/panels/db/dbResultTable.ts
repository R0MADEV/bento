import { t as i18nT } from '../../i18n'
import { icon } from '../../ui/helpers/icons'
import { type TableData } from '../../core/db/dbEngine'
import { type EditMeta } from './dbAccess'
import { renderCellValue } from './dbCellRender'
import { note, makeFilterInput, makeCsvBtn, makeResultWrap } from './dbWidgets'
import { editCell, deleteRow } from './dbRowEdit'

// Render cap: a SELECT * over a wide JOIN yields hundreds of columns; painting
// tens of thousands of cells at once freezes/crashes the WebView. We limit the DOM
// (the full data is still there; this only bounds what gets drawn).
export const MAX_COLS = 60
export const MAX_ROWS = 200
export const renderResultTable = (data: TableData, em?: EditMeta, loadMore?: (offset: number) => Promise<string[][]>): HTMLElement => {
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

export const preResult = (out: string): HTMLElement => {
  const pre = document.createElement('pre')
  pre.className = 'db-doc'
  const text = out.trim()
  pre.textContent = text.length > 200000 ? i18nT('db.truncated', { text: text.slice(0, 200000) }) : text || i18nT('db.noOutput')
  return pre
}
