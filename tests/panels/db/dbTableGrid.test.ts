// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { renderGrid } from '../../../src/panels/db/dbTableGrid'
import type { DbDetailHost } from '../../../src/panels/db/dbDetailHost'
import type { TableData } from '../../../src/panels/db/dbAccess'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let shown: HTMLElement[]
let alerts: string[]
let confirmed: boolean

const host = (): DbDetailHost => ({
  showDetail: (...nodes) => { shown = nodes; document.body.replaceChildren(...nodes) },
  detailHead: (path, count) => {
    const el = document.createElement('div')
    el.className = 'db-detail-head'
    el.dataset.path = path
    el.dataset.count = count
    return el
  },
})

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const data = (over: Partial<TableData> = {}): TableData =>
  ({ columns: ['id', 'name'], rows: [['2', 'bea'], ['10', 'ana']], ...over })

function grid(over: {
  pk?: string[]
  data?: TableData
  onRefresh?: () => void
  s?: DbServer
  fk?: Map<string, { ref_table: string; ref_column: string }>
} = {}) {
  renderGrid(host(), over.s ?? server(), 'app', 'users', over.data ?? data(),
    over.pk ?? ['id'], over.fk ?? new Map(), over.onRefresh)
  return { root: document.body, head: shown[0] as HTMLElement }
}

const bodyRows = (): string[][] =>
  [...document.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent ?? ''))

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
  shown = []
  alerts = []
  confirmed = true
  vi.stubGlobal('confirm', () => confirmed)
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
  vi.useRealTimers()
})

describe('rendering', () => {
  it('renders the rows into the detail pane under a header naming the table', () => {
    const { head } = grid()
    expect(head.dataset.path).toBe('app.users')
    expect(bodyRows().map(r => r.slice(0, 2))).toEqual([['2', 'bea'], ['10', 'ana']])
  })

  it('shows an empty-table note when there are no columns', () => {
    grid({ data: { columns: [], rows: [] } })
    expect(document.querySelector('.db-note')).not.toBeNull()
    expect(document.querySelector('table')).toBeNull()
  })
})

describe('editability', () => {
  it('makes cells editable and focusable when a primary key exists', () => {
    grid()
    expect(document.querySelectorAll('td.db-editable[tabindex]').length).toBe(4)
  })

  it('stays read-only when the table has no primary key', () => {
    grid({ pk: [] })
    expect(document.querySelector('td.db-editable')).toBeNull()
  })

  it('offers a delete button only when editable', () => {
    grid({ pk: [] })
    const readOnlyActions = document.querySelectorAll('.db-row-actions button').length
    document.body.replaceChildren()
    grid()
    expect(document.querySelectorAll('.db-row-actions button').length).toBeGreaterThan(readOnlyActions)
  })
})

describe('keyboard navigation', () => {
  it('moves focus between cells with the arrow keys', () => {
    grid()
    const cells = [...document.querySelectorAll('td[tabindex]')] as HTMLElement[]
    cells[0].focus()
    cells[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(cells[1])
    cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(cells[3])
    cells[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(cells[1])
    cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(cells[0])
  })

  it('opens the editor on Enter', () => {
    grid()
    const cell = document.querySelector('td[tabindex]') as HTMLElement
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(cell.querySelector('input')).not.toBeNull()
  })
})

describe('sorting and filtering', () => {
  it('sorts numbers numerically, not as text', () => {
    grid()
    ;(document.querySelectorAll('thead th')[0] as HTMLElement).click()
    expect(bodyRows().map(r => r[0])).toEqual(['2', '10'])
  })

  it('hides non-matching rows and updates the count', () => {
    vi.useFakeTimers()
    grid()
    const input = document.querySelector('.db-filter') as HTMLInputElement
    input.value = 'ana'
    input.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(150)
    const visible = [...document.querySelectorAll('tbody tr')].filter(tr => (tr as HTMLElement).style.display !== 'none')
    expect(visible).toHaveLength(1)
    expect(document.querySelector('.db-result-count')!.textContent).toBe('1 / 2')
  })
})

describe('row detail', () => {
  it('opens a modal listing every column of the row and closes it on Escape', () => {
    grid()
    ;(document.querySelector('.db-row-actions button') as HTMLButtonElement).click()
    const modal = document.querySelector('.db-row-modal')!
    expect([...modal.querySelectorAll('.db-row-modal-key')].map(e => e.textContent)).toEqual(['id', 'name'])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.db-row-modal')).toBeNull()
  })

  it('renders a JSON column as a tree and NULL with its own styling', () => {
    grid({ data: { columns: ['payload', 'note'], rows: [['{"a":1}', 'NULL']] }, pk: [] })
    ;(document.querySelector('.db-row-actions button') as HTMLButtonElement).click()
    const vals = document.querySelectorAll('.db-row-modal-val')
    expect(vals[0].querySelector('.jt-node')).not.toBeNull()
    expect(vals[1].querySelector('.db-null')).not.toBeNull()
  })
})

describe('toolbar', () => {
  it('offers refresh and insert only when the caller can refresh', () => {
    grid()
    const withoutRefresh = document.querySelectorAll('.db-result-toolbar .db-action').length
    document.body.replaceChildren()
    grid({ onRefresh: () => {} })
    expect(document.querySelectorAll('.db-result-toolbar .db-action').length).toBe(withoutRefresh + 2)
  })

  it('offers refresh but not insert on a table with no primary key', () => {
    grid({ pk: [], onRefresh: () => {} })
    const titles = [...document.querySelectorAll('.db-result-toolbar .db-action')].map(b => b.getAttribute('title'))
    expect(titles.filter(Boolean)).toHaveLength(2)
  })
})

describe('insert row', () => {
  const openInsert = (): HTMLTableRowElement => {
    const buttons = [...document.querySelectorAll('.db-result-toolbar .db-action')] as HTMLButtonElement[]
    buttons[buttons.length - 1].click()
    return document.querySelector('.db-insert-row') as HTMLTableRowElement
  }

  it('refuses to insert when every field was left empty', async () => {
    grid({ onRefresh: () => {} })
    openInsert()
    ;(document.querySelector('.db-insert-row .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(alerts).toHaveLength(1)
  })

  it('inserts only the filled columns and refreshes', async () => {
    const onRefresh = vi.fn()
    grid({ onRefresh })
    const itr = openInsert()
    ;(itr.querySelectorAll('input')[1] as HTMLInputElement).value = 'eva'
    ;(itr.querySelector('.db-connect') as HTMLButtonElement).click()
    await flush()
    const sql = (mocks.invoke.mock.calls[0][1] as { sql: string }).sql
    expect(sql).toContain('INSERT INTO `app`.`users` (`name`) VALUES (\'eva\')')
    expect(onRefresh).toHaveBeenCalled()
  })

  it('sends a real NULL for fields toggled to NULL', async () => {
    grid({ onRefresh: () => {} })
    const itr = openInsert()
    ;(itr.querySelectorAll('.db-null-btn')[1] as HTMLButtonElement).click()
    ;(itr.querySelector('.db-connect') as HTMLButtonElement).click()
    await flush()
    expect((mocks.invoke.mock.calls[0][1] as { sql: string }).sql).toContain('VALUES (NULL)')
  })

  it('quotes the table the Postgres way', async () => {
    grid({ s: server({ kind: 'postgres' }), onRefresh: () => {} })
    const itr = openInsert()
    ;(itr.querySelectorAll('input')[1] as HTMLInputElement).value = 'eva'
    ;(itr.querySelector('.db-connect') as HTMLButtonElement).click()
    await flush()
    expect((mocks.invoke.mock.calls[0][1] as { sql: string }).sql).toContain('INSERT INTO "users" ("name")')
  })

  it('re-enables the button and reports the error when the insert fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('duplicate key'))
    grid({ onRefresh: () => {} })
    const itr = openInsert()
    ;(itr.querySelectorAll('input')[0] as HTMLInputElement).value = '3'
    const ok = itr.querySelector('.db-connect') as HTMLButtonElement
    ok.click()
    await flush()
    expect(ok.disabled).toBe(false)
    expect(alerts.join()).toContain('duplicate key')
  })

  it('discards the draft row on cancel', () => {
    grid({ onRefresh: () => {} })
    openInsert()
    ;(document.querySelector('.db-insert-row .db-doc-cancel') as HTMLButtonElement).click()
    expect(document.querySelector('.db-insert-row')).toBeNull()
  })
})
