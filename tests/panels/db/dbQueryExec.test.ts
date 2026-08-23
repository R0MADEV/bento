// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createQueryRunner } from '../../../src/panels/db/dbQueryExec'
import type { TableData } from '../../../src/panels/db/dbAccess'
import type { ForeignKey } from '../../../src/panels/db/queryBuilders'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const runner = (over: { s?: DbServer; names?: string[]; rels?: ForeignKey[] } = {}) =>
  createQueryRunner(over.s ?? server(), 'app', over.names ?? ['users'], Promise.resolve(over.rels ?? []))

const sqlOf = (call: number): string => (mocks.invoke.mock.calls[call][1] as { sql: string }).sql

const rows = (over: Partial<TableData> = {}): TableData =>
  ({ columns: ['id', 'name'], rows: [['1', 'ana']], ...over })

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(rows())
})

describe('executeQuery dispatch', () => {
  it('runs a mongosh script and shows the raw output', async () => {
    mocks.invoke.mockResolvedValue('  two docs  ')
    const el = await runner({ s: server({ kind: 'mongodb' }) }).executeQuery('db.users.find()')
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_mongo_query', expect.objectContaining({ script: 'db.users.find()' }))
    expect(el.textContent).toBe('two docs')
  })

  it('runs a redis-cli command and shows the raw output', async () => {
    mocks.invoke.mockResolvedValue('OK')
    const el = await runner({ s: server({ kind: 'redis', password: 'pw' }) }).executeQuery('GET k')
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_redis_command', expect.objectContaining({ command: 'GET k', password: 'pw' }))
    expect(el.textContent).toBe('OK')
  })
})

describe('executeQuery for SQL', () => {
  it('caps the row count and pins the MySQL planner to a greedy plan', async () => {
    await runner().executeQuery('SELECT * FROM users')
    expect(sqlOf(0)).toContain('optimizer_search_depth=1')
    expect(sqlOf(0).toLowerCase()).toContain('limit')
  })

  it('rewrites identifiers instead of pinning the planner on Postgres', async () => {
    await runner({ s: server({ kind: 'postgres' }), names: ['public.Client'] }).executeQuery('SELECT * FROM public.Client')
    expect(sqlOf(0)).not.toContain('optimizer_search_depth')
    expect(sqlOf(0)).toContain('"public"."Client"')
  })

  it('returns a grid of the rows', async () => {
    const el = await runner().executeQuery('SELECT id FROM users LIMIT 1')
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1)
  })
})

describe('editable results', () => {
  it('makes a plain SELECT * of a known table editable', async () => {
    mocks.invoke
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(['id'])
    const el = await runner().executeQuery('SELECT * FROM users')
    expect(el.querySelector('.db-editable')).not.toBeNull()
  })

  it('leaves a join or a projection read-only', async () => {
    const el = await runner().executeQuery('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id')
    expect(el.querySelector('.db-editable')).toBeNull()
  })

  it('leaves a SELECT * of an unknown table read-only', async () => {
    const el = await runner().executeQuery('SELECT * FROM ghosts')
    expect(el.querySelector('.db-editable')).toBeNull()
  })

  it('offers no delete column when the primary key lookup fails', async () => {
    mocks.invoke
      .mockResolvedValueOnce(rows())
      .mockRejectedValueOnce(new Error('denied'))
    const el = await runner().executeQuery('SELECT * FROM users')
    // Without a primary key there is no way to address a row; the backend
    // rejects an UPDATE with no WHERE, so only the delete column is dropped.
    expect(el.querySelector('.db-row-actions')).toBeNull()
  })
})

describe('pagination of a capped query', () => {
  const page = (n: number): TableData => ({ columns: ['id'], rows: Array.from({ length: n }, (_, i) => [String(i)]) })

  it('pages a query the runner had to cap', async () => {
    mocks.invoke.mockResolvedValue(page(200))
    const el = await runner({ names: ['ghosts'] }).executeQuery('SELECT id FROM ghosts')
    const btn = el.querySelector('.db-load-more') as HTMLButtonElement
    expect(btn).not.toBeNull()
    btn.click()
    await new Promise(r => setTimeout(r, 0))
    expect(sqlOf(1)).toContain('OFFSET 200')
  })

  it('does not page a query that already had its own LIMIT', async () => {
    mocks.invoke.mockResolvedValue(page(200))
    const el = await runner({ names: ['ghosts'] }).executeQuery('SELECT id FROM ghosts LIMIT 200')
    expect(el.querySelector('.db-load-more')).toBeNull()
  })
})

describe('explain', () => {
  it('asks the engine for the plan without running the query', async () => {
    await runner().explain('SELECT * FROM users')
    expect(sqlOf(0)).toContain('EXPLAIN SELECT * FROM users')
  })

  it('drops a trailing semicolon before prefixing EXPLAIN', async () => {
    await runner().explain('SELECT 1;')
    expect(sqlOf(0)).toContain('EXPLAIN SELECT 1')
    expect(sqlOf(0)).not.toContain('SELECT 1;')
  })

  it('fixes identifiers on Postgres and pins the planner on MySQL', async () => {
    await runner({ s: server({ kind: 'postgres' }), names: ['public.Client'] }).explain('SELECT * FROM public.Client')
    expect(sqlOf(0)).toBe('EXPLAIN SELECT * FROM "public"."Client"')

    mocks.invoke.mockClear()
    await runner().explain('SELECT * FROM users')
    expect(sqlOf(0)).toContain('optimizer_search_depth=1')
  })

  it('shows the plan under a hint on how to read it', async () => {
    const el = await runner().explain('SELECT * FROM users')
    expect(el.querySelector('.db-detail-hint')).not.toBeNull()
    expect(el.querySelector('table')).not.toBeNull()
  })
})
