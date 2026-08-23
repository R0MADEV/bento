// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import {
  KIND_LABEL, isMongo, isPg, isRedis, envValue, sqlCmd, creds, target, sqlEscQ,
  parseRedisLines, fetchColumns, listDatabases, listTables, fetchRelations,
} from '../../../src/panels/db/dbAccess'
import type { DbServer, DbKind } from '../../../src/core/db/dbServer'

function server(over: Partial<DbServer> = {}): DbServer {
  return { kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'db1', ...over }
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('engine predicates', () => {
  it('recognises each engine and treats mariadb as plain SQL', () => {
    expect(isMongo(server({ kind: 'mongodb' }))).toBe(true)
    expect(isPg(server({ kind: 'postgres' }))).toBe(true)
    expect(isRedis(server({ kind: 'redis' }))).toBe(true)
    const maria = server({ kind: 'mariadb' })
    expect([isMongo(maria), isPg(maria), isRedis(maria)]).toEqual([false, false, false])
  })

  it('labels every kind', () => {
    const kinds: DbKind[] = ['mysql', 'mariadb', 'mongodb', 'postgres', 'redis']
    kinds.forEach(k => expect(KIND_LABEL[k]).toBeTruthy())
  })
})

describe('invoke argument helpers', () => {
  it('routes SQL commands to the pg or mysql backend', () => {
    expect(sqlCmd(server({ kind: 'postgres' }), 'rows')).toBe('db_docker_pg_rows')
    expect(sqlCmd(server({ kind: 'mysql' }), 'rows')).toBe('db_docker_mysql_rows')
    expect(sqlCmd(server({ kind: 'mariadb' }), 'pk')).toBe('db_docker_mysql_pk')
  })

  it('defaults missing credentials to empty strings', () => {
    expect(creds(server())).toEqual({ user: '', password: '' })
    expect(creds(server({ user: 'root', password: 'pw' }))).toEqual({ user: 'root', password: 'pw' })
  })

  it('targets the container when there is one and the host otherwise', () => {
    expect(target(server({ container: 'c1' }))).toEqual({ container: 'c1', host: '127.0.0.1', port: 3306 })
    expect(target(server({ source: 'local', container: undefined, host: 'localhost', port: 5432 })))
      .toEqual({ container: '', host: 'localhost', port: 5432 })
  })
})

describe('envValue', () => {
  it('reads the value after the first equals sign', () => {
    expect(envValue(['A=1', 'MYSQL_ROOT_PASSWORD=p=ss'], 'MYSQL_ROOT_PASSWORD')).toBe('p=ss')
  })

  it('returns empty for a missing key and does not match a key that merely shares a prefix', () => {
    expect(envValue(['REDIS_PASSWORD_FILE=/x'], 'REDIS_PASSWORD')).toBe('')
    expect(envValue([], 'ANY')).toBe('')
  })
})

describe('sqlEscQ', () => {
  it('doubles single quotes so a value cannot break out of a literal', () => {
    expect(sqlEscQ("O'Brien")).toBe("O''Brien")
    expect(sqlEscQ("'; DROP TABLE t; --")).toBe("''; DROP TABLE t; --")
  })
})

describe('parseRedisLines', () => {
  it('keeps only numbered lines and unwraps quoted values', () => {
    const raw = 'some header\n1) "hello"\n2) 42\nnot numbered\n3) "a\\"b"'
    expect(parseRedisLines(raw)).toEqual(['hello', '42', 'a"b'])
  })

  it('unescapes backslashes inside quoted values', () => {
    expect(parseRedisLines('1) "a\\\\b"')).toEqual(['a\\b'])
  })

  it('returns nothing when no line is numbered', () => {
    expect(parseRedisLines('(empty array)')).toEqual([])
  })
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
