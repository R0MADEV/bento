// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { builtSql, expectSqlBuilt, fakeDbSql } from '../../helpers/dbSql'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createQueryChips, CHIP_CAP } from '../../../src/panels/db/dbQueryChips'
import type { ForeignKey } from '../../../src/core/db/queryBuilders'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const fk = (table: string, column: string, refTable: string): ForeignKey =>
  ({ table, column, ref_table: refTable, ref_column: 'id' })

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

function chips(over: { s?: DbServer; names?: string[]; rels?: ForeignKey[] } = {}) {
  const onPick = vi.fn()
  const el = createQueryChips({
    s: over.s ?? server(),
    names: over.names ?? ['users', 'orders'],
    relationsReady: Promise.resolve(over.rels ?? []),
    onPick,
  })
  document.body.replaceChildren(el)
  return { el, onPick }
}

const labels = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.db-query-chip')].map(c => c.textContent ?? '')

const typeFilter = (el: HTMLElement, q: string): void => {
  const input = el.querySelector('.db-query-filter') as HTMLInputElement
  input.value = q
  input.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) =>
    fakeDbSql(cmd, args as Record<string, unknown>))
})

describe('table chips', () => {
  it('shows one chip per table', () => {
    expect(labels(chips().el)).toEqual(['users', 'orders'])
  })

  it('asks the backend for that table example and hands it back', async () => {
    const { el, onPick } = chips()
    ;(el.querySelector('.db-query-chip') as HTMLButtonElement).click()
    await flush()
    expectSqlBuilt(mocks.invoke, 'db_sql_example', { kind: 'mysql', name: 'users' })
    expect(onPick).toHaveBeenCalledWith(builtSql('db_sql_example'))
  })

  it('caps how many chips it paints and says how many were left out', () => {
    const names = Array.from({ length: CHIP_CAP + 7 }, (_, i) => `t${i}`)
    const { el } = chips({ names })
    expect(labels(el)).toHaveLength(CHIP_CAP)
    expect(el.querySelector('.db-detail-hint')!.textContent).toContain('7')
  })
})

describe('relation chips', () => {
  it('adds a chip per table once the relations arrive', async () => {
    const { el } = chips({ rels: [fk('orders', 'user_id', 'users')] })
    await flush()
    expect(labels(el).some(l => l.includes('orders') && l.includes('users'))).toBe(true)
  })

  it('describes the joining columns in the tooltip', async () => {
    const { el } = chips({ rels: [fk('orders', 'user_id', 'users')] })
    await flush()
    const rel = el.querySelector('.db-query-chip-rel') as HTMLButtonElement
    expect(rel.title).toContain('orders.user_id → users.id')
  })

  it('skips relations entirely on Redis', async () => {
    const { el } = chips({ s: server({ kind: 'redis' }), rels: [fk('orders', 'user_id', 'users')] })
    await flush()
    expect(el.querySelector('.db-query-chip-rel')).toBeNull()
  })
})

describe('filtering', () => {
  it('keeps only chips matching the text, case-insensitively', () => {
    const { el } = chips()
    typeFilter(el, 'ORD')
    expect(labels(el)).toEqual(['orders'])
  })

  it('shows everything again when the filter is cleared', () => {
    const { el } = chips()
    typeFilter(el, 'ord')
    typeFilter(el, '')
    expect(labels(el)).toHaveLength(2)
  })
})

describe('group toggle', () => {
  it('offers no toggle on Redis, where there is only one group', () => {
    expect(chips({ s: server({ kind: 'redis' }) }).el.querySelector('.db-query-toggle-btn')).toBeNull()
  })

  it('narrows to tables or to relations and back to all', async () => {
    const { el } = chips({ rels: [fk('orders', 'user_id', 'users')] })
    await flush()
    const [all, tablesBtn, relsBtn] = [...el.querySelectorAll('.db-query-toggle-btn')] as HTMLButtonElement[]

    relsBtn.click()
    expect(labels(el).every(l => l.includes('▸'))).toBe(true)
    expect(relsBtn.classList.contains('active')).toBe(true)

    tablesBtn.click()
    expect(labels(el)).toEqual(['users', 'orders'])

    all.click()
    expect(labels(el)).toHaveLength(3)
  })
})
