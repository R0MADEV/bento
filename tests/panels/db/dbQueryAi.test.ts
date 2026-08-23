// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  askAi: vi.fn(),
  fetchColumns: vi.fn(async () => [] as string[]),
}))

vi.mock('../../../src/ui/askAi', () => ({ askAi: mocks.askAi }))

import { createAiQueryButton } from '../../../src/panels/db/dbQueryAi'
import type { ForeignKey } from '../../../src/panels/db/queryBuilders'
import type { AiTool, AiQueryRunner } from '../../../src/ui/askAi'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const fk = (table: string, column: string, refTable: string): ForeignKey =>
  ({ table, column, ref_table: refTable, ref_column: 'id' })

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

function button(over: {
  s?: DbServer
  names?: string[]
  rels?: ForeignKey[]
  executeQuery?: (q: string) => Promise<HTMLElement>
} = {}): HTMLButtonElement {
  return createAiQueryButton({
    s: over.s ?? server(),
    db: 'app',
    names: over.names ?? ['users', 'orders'],
    relationsReady: Promise.resolve(over.rels ?? []),
    executeQuery: over.executeQuery ?? (async () => document.createElement('div')),
    fetchColumns: mocks.fetchColumns,
  })
}

const click = async (btn: HTMLButtonElement): Promise<void> => { btn.click(); await flush() }

const prompt = (): string => mocks.askAi.mock.calls[0][0] as string
const tools = (): AiTool[] => mocks.askAi.mock.calls[0][3] as AiTool[]
const runner = (): AiQueryRunner => mocks.askAi.mock.calls[0][2] as AiQueryRunner

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.askAi.mockReset()
  mocks.fetchColumns.mockReset()
  mocks.fetchColumns.mockResolvedValue([])
})

describe('schema in the prompt', () => {
  it('names the engine, the database and its tables', async () => {
    await click(button())
    expect(prompt()).toContain('MySQL')
    expect(prompt()).toContain('"app"')
    expect(prompt()).toContain('users, orders')
  })

  it('inlines a small set of relations', async () => {
    await click(button({ rels: [fk('orders', 'user_id', 'users')] }))
    expect(prompt()).toContain('orders.user_id → users.id')
  })

  it('leaves a large set of relations to the tool instead of inlining them', async () => {
    const many = Array.from({ length: 51 }, (_, i) => fk(`t${i}`, 'c', 'users'))
    await click(button({ rels: many }))
    expect(prompt()).not.toContain('t50.c → users.id')
  })
})

describe('dialect per engine', () => {
  it('asks for mongosh with $lookup on Mongo', async () => {
    await click(button({ s: server({ kind: 'mongodb' }) }))
    expect(prompt()).toContain('mongosh')
    expect(prompt()).toContain('$lookup')
  })

  it('asks for a redis-cli command on Redis', async () => {
    await click(button({ s: server({ kind: 'redis' }) }))
    expect(prompt()).toContain('redis-cli')
  })

  it('spells out the Postgres quoting rule', async () => {
    await click(button({ s: server({ kind: 'postgres' }) }))
    expect(prompt()).toContain('"esquema"."tabla"')
  })
})

describe('tools', () => {
  it('offers column and relation lookups on SQL and Mongo', async () => {
    await click(button())
    expect(tools().map(t => t.name)).toEqual(['get_columns', 'get_relations'])
  })

  it('offers no tools on Redis and drops the tool guidance from the prompt', async () => {
    await click(button({ s: server({ kind: 'redis' }) }))
    expect(tools()).toEqual([])
    expect(prompt()).not.toContain('get_columns')
  })

  it('reads real columns for the requested tables', async () => {
    mocks.fetchColumns.mockResolvedValue(['id (int)'])
    await click(button())
    const out = await tools()[0].run({ tables: ['users'] })
    expect(out).toContain('users: id (int)')
  })

  it('says so when a table has no columns to report', async () => {
    await click(button())
    expect(await tools()[0].run({ tables: ['ghosts'] })).toContain('desconocidas')
  })

  it('caps how many tables one column lookup may ask about', async () => {
    await click(button())
    await tools()[0].run({ tables: Array.from({ length: 40 }, (_, i) => `t${i}`) })
    expect(mocks.fetchColumns).toHaveBeenCalledTimes(30)
  })

  it('ignores a malformed tool argument instead of throwing', async () => {
    await click(button())
    expect(await tools()[0].run({ tables: 'not an array' })).toContain('sin columnas')
    expect(await tools()[1].run({})).toContain('sin relaciones')
  })

  it('returns only the relations touching the requested tables', async () => {
    await click(button({ rels: [fk('orders', 'user_id', 'users'), fk('items', 'sku', 'products')] }))
    const out = await tools()[1].run({ tables: ['users'] })
    expect(out).toContain('orders.user_id → users.id')
    expect(out).not.toContain('items.sku')
  })
})

describe('running what the AI wrote', () => {
  it('hands back the result element when the query works', async () => {
    const result = document.createElement('table')
    await click(button({ executeQuery: async () => result }))
    expect(await runner()('SELECT 1')).toBe(result)
  })

  it('shows the error with a fix-with-AI button when the query fails', async () => {
    await click(button({ executeQuery: async () => { throw new Error('unknown column x') } }))
    const el = await runner()('SELECT x FROM users')
    expect(el.textContent).toContain('unknown column x')
    expect(el.querySelector('.db-connect')).not.toBeNull()
  })

  it('resends the failed query and its error when fix-with-AI is used', async () => {
    await click(button({ executeQuery: async () => { throw new Error('unknown column x') } }))
    const el = await runner()('SELECT x FROM users')
    ;(el.querySelector('.db-connect') as HTMLButtonElement).click()
    const retry = mocks.askAi.mock.calls[1][0] as string
    expect(retry).toContain('SELECT x FROM users')
    expect(retry).toContain('unknown column x')
  })
})
