// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { renderResultTable, preResult, MAX_COLS, MAX_ROWS } from '../../../src/panels/db/dbResultTable'
import type { TableData, EditMeta } from '../../../src/panels/db/dbAccess'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  vi.stubGlobal('confirm', () => true)
  vi.stubGlobal('alert', () => {})
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
  vi.useRealTimers()
})

const data = (over: Partial<TableData> = {}): TableData =>
  ({ columns: ['id', 'name'], rows: [['2', 'bea'], ['10', 'ana']], ...over })

const bodyRows = (el: HTMLElement): string[][] =>
  [...el.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent ?? ''))

const editMeta = (): EditMeta => ({
  s: { kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1' } as DbServer,
  db: 'app', table: 'users', pkIdx: [0], fkColMap: new Map(),
})

describe('empty results', () => {
  it('says there are no results for a SELECT that returned nothing', () => {
    expect(renderResultTable({ columns: [], rows: [] }).className).toBe('db-detail-hint')
  })

  it('says OK for a statement that returned rows but no columns', () => {
    const el = renderResultTable({ columns: [], rows: [[]] })
    expect(el.textContent).not.toBe('')
    expect(el.className).toBe('db-detail-hint')
  })
})

describe('rendering and counting', () => {
  it('paints one row per record and shows the total', () => {
    const el = renderResultTable(data())
    expect(bodyRows(el)).toEqual([['2', 'bea'], ['10', 'ana']])
    expect(el.querySelector('.db-result-count')!.textContent).toBe('2')
  })

  it('caps the painted columns and warns when there are more', () => {
    const columns = Array.from({ length: MAX_COLS + 5 }, (_, i) => `c${i}`)
    const el = renderResultTable({ columns, rows: [columns.map(String)] })
    expect(el.querySelectorAll('thead th')).toHaveLength(MAX_COLS)
    expect(el.querySelector('.db-detail-hint')).not.toBeNull()
  })
})

describe('sorting', () => {
  it('sorts numerically on the first click and reverses on the second', () => {
    const el = renderResultTable(data())
    const th = el.querySelectorAll('thead th')[0] as HTMLElement
    th.click()
    expect(bodyRows(el).map(r => r[0])).toEqual(['2', '10'])
    th.click()
    expect(bodyRows(el).map(r => r[0])).toEqual(['10', '2'])
    expect(th.classList.contains('db-sort-desc')).toBe(true)
  })

  it('sorts text alphabetically', () => {
    const el = renderResultTable(data())
    ;(el.querySelectorAll('thead th')[1] as HTMLElement).click()
    expect(bodyRows(el).map(r => r[1])).toEqual(['ana', 'bea'])
  })
})

describe('filtering', () => {
  it('keeps only matching rows and shows matched over total', () => {
    vi.useFakeTimers()
    const el = renderResultTable(data())
    const input = el.querySelector('.db-filter') as HTMLInputElement
    input.value = 'ANA'
    input.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(150)
    expect(bodyRows(el)).toEqual([['10', 'ana']])
    expect(el.querySelector('.db-result-count')!.textContent).toBe('1 / 2')
  })
})

describe('editable results', () => {
  it('stays read-only without edit metadata', () => {
    const el = renderResultTable(data())
    expect(el.querySelector('.db-editable')).toBeNull()
    expect(el.querySelector('.db-row-actions')).toBeNull()
  })

  it('marks cells editable and adds a delete button when there is a primary key', () => {
    const el = renderResultTable(data(), editMeta())
    expect(el.querySelectorAll('.db-editable').length).toBe(4)
    expect(el.querySelectorAll('.db-row-actions').length).toBe(2)
  })

  it('adds no delete column when the table has no primary key', () => {
    const el = renderResultTable(data(), { ...editMeta(), pkIdx: [] })
    expect(el.querySelector('.db-row-actions')).toBeNull()
  })

  it('drops the deleted record from the data, not just from the DOM', async () => {
    const d = data()
    const el = renderResultTable(d, editMeta())
    ;(el.querySelector('.db-row-actions button') as HTMLButtonElement).click()
    await flush()
    expect(d.rows).toEqual([['10', 'ana']])
    // the trailing cell is the row-actions column
    expect(bodyRows(el)).toEqual([['10', 'ana', '']])
  })
})

describe('pagination', () => {
  const fullPage = (): TableData =>
    ({ columns: ['id'], rows: Array.from({ length: MAX_ROWS }, (_, i) => [String(i)]) })

  it('offers no load-more button for a partial page', () => {
    expect(renderResultTable(data(), undefined, async () => []).querySelector('.db-load-more')).toBeNull()
  })

  it('appends the next page and keeps the button while pages stay full', async () => {
    const el = renderResultTable(fullPage(), undefined, async () => Array.from({ length: MAX_ROWS }, (_, i) => [`n${i}`]))
    const btn = el.querySelector('.db-load-more') as HTMLButtonElement
    btn.click()
    await flush()
    expect(el.querySelectorAll('tbody tr')).toHaveLength(MAX_ROWS * 2)
    expect(el.querySelector('.db-load-more')).not.toBeNull()
  })

  it('removes the button once a short page comes back', async () => {
    const el = renderResultTable(fullPage(), undefined, async () => [['x']])
    ;(el.querySelector('.db-load-more') as HTMLButtonElement).click()
    await flush()
    expect(el.querySelector('.db-load-more')).toBeNull()
  })

  it('re-enables the button when loading more fails', async () => {
    const el = renderResultTable(fullPage(), undefined, async () => { throw new Error('gone') })
    const btn = el.querySelector('.db-load-more') as HTMLButtonElement
    btn.click()
    await flush()
    expect(btn.disabled).toBe(false)
  })
})

describe('preResult', () => {
  it('shows trimmed output', () => {
    expect(preResult('  hello\n').textContent).toBe('hello')
  })

  it('reports empty output instead of showing nothing', () => {
    expect(preResult('   ').textContent).not.toBe('')
  })

  it('truncates very long output', () => {
    const el = preResult('x'.repeat(250000))
    expect(el.textContent!.length).toBeLessThan(250000)
  })
})
