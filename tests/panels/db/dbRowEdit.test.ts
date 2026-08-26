// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { builtSql, expectSqlBuilt, fakeDbSql } from '../../helpers/dbSql'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { editCell, deleteRow } from '../../../src/panels/db/dbRowEdit'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const COLUMNS = ['id', 'name']
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let confirmed: boolean
let alerts: string[]

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) =>
    fakeDbSql(cmd, args as Record<string, unknown>))
  confirmed = true
  alerts = []
  vi.stubGlobal('confirm', () => confirmed)
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
})

function openEditor(over: { row?: string[]; colIdx?: number; s?: DbServer } = {}) {
  const row = over.row ?? ['7', 'ana']
  const td = document.createElement('td')
  const tr = document.createElement('tr')
  tr.appendChild(td)
  editCell(over.s ?? server(), 'app', 'users', COLUMNS, row, over.colIdx ?? 1, [0], td)
  return { td, row, input: td.querySelector('input') as HTMLInputElement }
}

describe('editCell input', () => {
  it('opens prefilled with the current value and selected', () => {
    const { input } = openEditor()
    expect(input.value).toBe('ana')
  })

  it('shows an empty box for a NULL cell rather than the literal NULL', () => {
    const { input } = openEditor({ row: ['7', 'NULL'] })
    expect(input.value).toBe('')
  })

  it('restores the original value on Escape without touching the backend', () => {
    const { td, input } = openEditor()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(td.textContent).toBe('ana')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('does not write when the value is unchanged', async () => {
    const { td, input } = openEditor()
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(td.textContent).toBe('ana')
  })
})

describe('editCell update', () => {
  it('sends the update and repaints the cell with the new value', async () => {
    const { td, row, input } = openEditor()
    input.value = 'eva'
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_mysql_update', expect.objectContaining({
      db: 'app', table: 'users', column: 'name', value: 'eva', wheres: [['id', '7']],
    }))
    expect(row[1]).toBe('eva')
    expect(td.textContent).toBe('eva')
  })

  it('asks for confirmation first and restores the cell when refused', async () => {
    confirmed = false
    const { td, row, input } = openEditor()
    input.value = 'eva'
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(row[1]).toBe('ana')
    expect(td.textContent).toBe('ana')
  })

  // El UPDATE lo escribe `bento_db::query`; aquí importa a qué fila apunta y
  // que se ejecute tal cual vuelve.
  it('writes a real NULL through the statement the backend builds', async () => {
    const { td, row } = openEditor()
    const nullBtn = td.querySelector('.db-null-btn') as HTMLButtonElement
    nullBtn.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }))
    await flush()
    expectSqlBuilt(mocks.invoke, 'db_sql_set_null', { kind: 'mysql', db: 'app', table: 'users', column: 'name' })
    const run = mocks.invoke.mock.calls.find(([cmd]) => cmd === 'db_docker_mysql_query')
    expect(run![1]).toMatchObject({ sql: builtSql('db_sql_set_null') })
    expect(row[1]).toBe('NULL')
    expect(td.textContent).toBe('NULL')
  })

  it('tells the backend which engine the row belongs to', async () => {
    const { td } = openEditor({ s: server({ kind: 'postgres' }), row: ['7', 'ana'] })
    ;(td.querySelector('.db-null-btn') as HTMLButtonElement).dispatchEvent(new MouseEvent('mousedown', { cancelable: true }))
    await flush()
    expectSqlBuilt(mocks.invoke, 'db_sql_set_null', { kind: 'postgres', column: 'name' })
  })

  it('reports a plain failure and puts the old value back', async () => {
    mocks.invoke.mockRejectedValue(new Error('column is generated'))
    const { td, input } = openEditor()
    input.value = 'eva'
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(alerts.join()).toContain('column is generated')
    expect(td.textContent).toBe('ana')
  })
})

describe('editCell foreign-key column', () => {
  it('offers the referenced rows as a dropdown with the current value selected', async () => {
    mocks.invoke.mockResolvedValue({ columns: ['id', 'label'], rows: [['1', 'one'], ['7', 'seven']] })
    const td = document.createElement('td')
    editCell(server(), 'app', 'orders', ['id', 'user_id'], ['1', '7'], 1, [0], td,
      { ref_table: 'users', ref_column: 'id' })
    await flush()
    const sel = td.querySelector('select') as HTMLSelectElement
    expect([...sel.options].map(o => o.value)).toEqual(['1', '7'])
    expect(sel.value).toBe('7')
  })

  it('falls back to a plain text box when the referenced column is missing', async () => {
    mocks.invoke.mockResolvedValue({ columns: ['other'], rows: [] })
    const td = document.createElement('td')
    editCell(server(), 'app', 'orders', ['id', 'user_id'], ['1', '7'], 1, [0], td,
      { ref_table: 'users', ref_column: 'id' })
    await flush()
    expect(td.querySelector('select')).toBeNull()
    expect(td.querySelector('input')).not.toBeNull()
  })
})

describe('deleteRow', () => {
  it('deletes by primary key and drops the row element', async () => {
    const tr = document.createElement('tr')
    document.body.appendChild(tr)
    await deleteRow(server(), 'app', 'users', COLUMNS, ['7', 'ana'], [0], tr)
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_mysql_delete', expect.objectContaining({
      table: 'users', wheres: [['id', '7']],
    }))
    expect(tr.isConnected).toBe(false)
  })

  it('does nothing when the confirmation is refused', async () => {
    confirmed = false
    const tr = document.createElement('tr')
    document.body.appendChild(tr)
    await deleteRow(server(), 'app', 'users', COLUMNS, ['7', 'ana'], [0], tr)
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(tr.isConnected).toBe(true)
  })

  it('hands control to the caller instead of removing the row when a callback is given', async () => {
    const tr = document.createElement('tr')
    document.body.appendChild(tr)
    const onDeleted = vi.fn()
    await deleteRow(server(), 'app', 'users', COLUMNS, ['7', 'ana'], [0], tr, onDeleted)
    expect(onDeleted).toHaveBeenCalled()
    expect(tr.isConnected).toBe(true)
  })

  it('keeps the row and reports the error when the delete fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('fk constraint'))
    const tr = document.createElement('tr')
    document.body.appendChild(tr)
    await deleteRow(server(), 'app', 'users', COLUMNS, ['7', 'ana'], [0], tr)
    expect(alerts.join()).toContain('fk constraint')
    expect(tr.isConnected).toBe(true)
  })
})
