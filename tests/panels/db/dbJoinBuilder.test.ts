// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { createJoinBuilder } from '../../../src/panels/db/dbJoinBuilder'
import type { ForeignKey } from '../../../src/panels/db/queryBuilders'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const fk = (table: string, column: string, refTable: string): ForeignKey =>
  ({ table, column, ref_table: refTable, ref_column: 'id' })

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

const NAMES = ['users', 'orders', 'products']

function builder(over: { s?: DbServer; rels?: ForeignKey[] } = {}) {
  const onBuild = vi.fn()
  const el = createJoinBuilder({
    s: over.s ?? server(),
    names: NAMES,
    getRelations: () => over.rels ?? [],
    relationsReady: Promise.resolve(over.rels ?? []),
    onBuild,
  })
  document.body.replaceChildren(el)
  return { el, onBuild }
}

const pick = (el: HTMLElement, value: string): void => {
  const input = el.querySelector('.db-join-add') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('change'))
}

const chips = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.db-join-chips button')].map(b => b.textContent ?? '')

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
})

describe('availability', () => {
  it('is empty on Mongo and Redis, where there are no foreign keys to walk', () => {
    expect(builder({ s: server({ kind: 'mongodb' }) }).el.children).toHaveLength(0)
    expect(builder({ s: server({ kind: 'redis' }) }).el.children).toHaveLength(0)
  })

  it('offers every table as an autocomplete option on SQL', () => {
    const { el } = builder()
    expect([...el.querySelectorAll('datalist option')].map(o => (o as HTMLOptionElement).value)).toEqual(NAMES)
  })

  it('gives each builder its own datalist so two panels do not collide', () => {
    const a = builder().el.querySelector('datalist')!.id
    const b = builder().el.querySelector('datalist')!.id
    expect(a).not.toBe(b)
  })
})

describe('picking tables', () => {
  it('adds a chip per picked table and clears the box', () => {
    const { el } = builder()
    pick(el, 'users')
    expect(chips(el)[0]).toContain('users')
    expect((el.querySelector('.db-join-add') as HTMLInputElement).value).toBe('')
  })

  it('ignores an unknown table and a repeated one', () => {
    const { el } = builder()
    pick(el, 'ghosts')
    pick(el, 'users')
    pick(el, 'users')
    expect(chips(el)).toHaveLength(1)
  })

  it('removes a table when its chip is clicked', () => {
    const { el } = builder()
    pick(el, 'users')
    ;(el.querySelector('.db-join-chips button') as HTMLButtonElement).click()
    expect(chips(el)).toHaveLength(0)
  })
})

describe('building the query', () => {
  const build = (el: HTMLElement): void => { (el.querySelector('.db-connect') as HTMLButtonElement).click() }

  it('does nothing when no table was picked', async () => {
    const { el, onBuild } = builder()
    build(el)
    await flush()
    expect(onBuild).not.toHaveBeenCalled()
  })

  it('hands back a JOIN query for connected tables', async () => {
    const { el, onBuild } = builder({ rels: [fk('orders', 'user_id', 'users')] })
    pick(el, 'users')
    pick(el, 'orders')
    build(el)
    await flush()
    expect(onBuild).toHaveBeenCalledTimes(1)
    const sql = onBuild.mock.calls[0][0] as string
    expect(sql.toLowerCase()).toContain('join')
    expect(sql).toContain('orders')
    expect(sql).toContain('users')
  })

  it('explains that unconnected tables cannot be joined, and builds nothing', async () => {
    const { el, onBuild } = builder({ rels: [fk('orders', 'user_id', 'users')] })
    pick(el, 'users')
    pick(el, 'products')
    build(el)
    await flush()
    expect(onBuild).not.toHaveBeenCalled()
    expect(el.querySelector('.db-join-msg')!.textContent).not.toBe('')
  })

  it('clears a previous message on the next attempt', async () => {
    const { el } = builder({ rels: [fk('orders', 'user_id', 'users')] })
    pick(el, 'users')
    pick(el, 'products')
    build(el)
    await flush()
    ;(el.querySelectorAll('.db-join-chips button')[1] as HTMLButtonElement).click()
    pick(el, 'orders')
    build(el)
    await flush()
    expect(el.querySelector('.db-join-msg')!.textContent).toBe('')
  })
})
