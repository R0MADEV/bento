import { describe, expect, it } from 'vitest'
import {
  KIND_LABEL, isMongo, isPg, isRedis, envValue, sqlCmd, creds, target, sqlEscQ, parseRedisLines,
} from '../../../src/core/db/dbEngine'
import type { DbServer, DbKind } from '../../../src/core/db/dbServer'

function server(over: Partial<DbServer> = {}): DbServer {
  return { kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'db1', ...over }
}

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
