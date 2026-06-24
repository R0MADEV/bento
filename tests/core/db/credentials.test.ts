import { describe, it, expect } from 'vitest'
import { mysqlCreds, mongoCreds, pgCreds } from '../../../src/core/db/credentials'

describe('mysqlCreds', () => {
  it('prefers root with its password (sees every database)', () => {
    expect(mysqlCreds(['MYSQL_ROOT_PASSWORD=secret', 'MYSQL_USER=app', 'MYSQL_PASSWORD=app'])).toEqual({ user: 'root', password: 'secret' })
  })

  it('falls back to the app user when there is no root password', () => {
    expect(mysqlCreds(['MYSQL_USER=app', 'MYSQL_PASSWORD=app'])).toEqual({ user: 'app', password: 'app' })
  })

  it('allows empty root password', () => {
    expect(mysqlCreds(['MYSQL_ALLOW_EMPTY_PASSWORD=1'])).toEqual({ user: 'root', password: '' })
  })

  it('defaults to root with no password', () => {
    expect(mysqlCreds(['PATH=/usr/bin'])).toEqual({ user: 'root', password: '' })
  })
})

describe('mongoCreds', () => {
  it('reads the initdb root credentials', () => {
    expect(mongoCreds(['MONGO_INITDB_ROOT_USERNAME=admin', 'MONGO_INITDB_ROOT_PASSWORD=pw'])).toEqual({ user: 'admin', password: 'pw' })
  })

  it('returns empty credentials when none are set (no auth)', () => {
    expect(mongoCreds(['PATH=/usr/bin'])).toEqual({ user: '', password: '' })
  })
})

describe('pgCreds', () => {
  it('reads POSTGRES_* including the default database', () => {
    expect(pgCreds(['POSTGRES_USER=nixon', 'POSTGRES_PASSWORD=pw', 'POSTGRES_DB=db'])).toEqual({ user: 'nixon', password: 'pw', db: 'db' })
  })

  it('defaults to the postgres superuser and database', () => {
    expect(pgCreds(['PATH=/usr/bin'])).toEqual({ user: 'postgres', password: '', db: 'postgres' })
  })
})
