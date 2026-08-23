// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { fetchColumns, listDatabases, listTables, fetchRelations } from '../../../src/panels/db/dbAccess'
import type { DbServer } from '../../../src/core/db/dbServer'

function server(over: Partial<DbServer> = {}): DbServer {
  return { kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'db1', ...over }
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('listDatabases', () => {
  it('picks the command for each engine', async () => {
    mocks.invoke.mockResolvedValue([])
    await listDatabases(server({ kind: 'redis', password: 'pw' }))
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_redis_dbs', expect.objectContaining({ password: 'pw' }))

    await listDatabases(server({ kind: 'mongodb' }))
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_list_mongo', expect.anything())

    await listDatabases(server({ kind: 'mysql' }))
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_list_mysql', expect.anything())
  })

  it('connects Postgres through its maintenance database', async () => {
    mocks.invoke.mockResolvedValue([])
    await listDatabases(server({ kind: 'postgres' }))
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_pg_databases', expect.objectContaining({ db: 'postgres' }))

    await listDatabases(server({ kind: 'postgres', connectDb: 'app' }))
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_pg_databases', expect.objectContaining({ db: 'app' }))
  })
})

describe('listTables', () => {
  it('lists keys, collections or tables depending on the engine', async () => {
    mocks.invoke.mockResolvedValue([])
    await listTables(server({ kind: 'redis' }), '0')
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_redis_keys', expect.objectContaining({ db: '0' }))

    await listTables(server({ kind: 'mongodb' }), 'app')
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_mongo_collections', expect.anything())

    await listTables(server({ kind: 'postgres' }), 'app')
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_pg_tables', expect.anything())
  })
})

describe('fetchRelations', () => {
  it('has no relations for Redis and never calls the backend', async () => {
    expect(await fetchRelations(server({ kind: 'redis' }), '0')).toEqual([])
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('uses the heuristic reference command for Mongo and the FK one for SQL', async () => {
    mocks.invoke.mockResolvedValue([])
    await fetchRelations(server({ kind: 'mongodb' }), 'app')
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_mongo_refs', expect.anything())

    await fetchRelations(server({ kind: 'mysql' }), 'app')
    expect(mocks.invoke).toHaveBeenLastCalledWith('db_docker_mysql_fks', expect.anything())
  })

  it('degrades to no relations when the backend fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('no permission'))
    expect(await fetchRelations(server({ kind: 'mysql' }), 'app')).toEqual([])
  })
})

describe('fetchColumns', () => {
  it('reads Mongo keys from the first document', async () => {
    mocks.invoke.mockResolvedValue('_id\nname\n')
    expect(await fetchColumns(server({ kind: 'mongodb' }), 'app', 'users')).toEqual(['_id', 'name'])
  })

  // Pre-existing quirk kept by this refactor: the mongosh script is escaped
  // SQL-style (doubling quotes) rather than with backslashes.
  it('escapes quotes in the Mongo script the SQL way', async () => {
    mocks.invoke.mockResolvedValue('')
    await fetchColumns(server({ kind: 'mongodb' }), "a'b", 'users')
    const script = (mocks.invoke.mock.calls[0][1] as { script: string }).script
    expect(script).toContain("getSiblingDB('a''b')")
  })

  it('splits a qualified Postgres name into schema and table', async () => {
    mocks.invoke.mockResolvedValue({ columns: ['column_name', 'data_type'], rows: [['id', 'integer']] })
    expect(await fetchColumns(server({ kind: 'postgres' }), 'app', 'sales.orders')).toEqual(['id (integer)'])
    const sql = (mocks.invoke.mock.calls[0][1] as { sql: string }).sql
    expect(sql).toContain("table_schema='sales'")
    expect(sql).toContain("table_name='orders'")
  })

  it('defaults the Postgres schema to public', async () => {
    mocks.invoke.mockResolvedValue({ columns: [], rows: [] })
    await fetchColumns(server({ kind: 'postgres' }), 'app', 'orders')
    expect((mocks.invoke.mock.calls[0][1] as { sql: string }).sql).toContain("table_schema='public'")
  })

  it('queries information_schema for MySQL', async () => {
    mocks.invoke.mockResolvedValue({ columns: [], rows: [['id', 'int']] })
    expect(await fetchColumns(server({ kind: 'mysql' }), 'app', 'orders')).toEqual(['id (int)'])
  })

  it('returns no columns instead of throwing when the query fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('denied'))
    expect(await fetchColumns(server({ kind: 'mysql' }), 'app', 'orders')).toEqual([])
  })
})
