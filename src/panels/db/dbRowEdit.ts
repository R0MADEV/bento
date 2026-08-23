import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { isPg, sqlCmd, creds, target, type TableData } from '../../core/db/dbEngine'
import { renderCellValue } from './dbCellRender'
import { buildWheres } from './dbWidgets'
import { ident, qualifiedTable } from '../../core/db/sqlQuote'

export const editCell = (
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
        const w = wheres.map(([c, v]) => `${ident(s, c)} = '${v.replace(/'/g, "''")}'`).join(' AND ')
        const tblQ = qualifiedTable(s, db, table)
        await invoke(sqlCmd(s, 'query'), { ...target(s), db, sql: `UPDATE ${tblQ} SET ${ident(s, column)} = NULL WHERE ${w}`, ...creds(s) })
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

export const deleteRow = async (
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
