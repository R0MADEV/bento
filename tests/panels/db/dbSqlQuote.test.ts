import { describe, expect, it } from 'vitest'
import { ident, qualifiedTable, quoteValue } from '../../../src/panels/db/dbSqlQuote'
import type { DbServer } from '../../../src/core/db/dbServer'

const mysql: DbServer = { kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1' }
const maria: DbServer = { ...mysql, kind: 'mariadb' }
const pg: DbServer = { ...mysql, kind: 'postgres', port: 5432 }

describe('ident', () => {
  it('backticks identifiers on MySQL and MariaDB', () => {
    expect(ident(mysql, 'name')).toBe('`name`')
    expect(ident(maria, 'name')).toBe('`name`')
  })

  it('double-quotes identifiers on Postgres', () => {
    expect(ident(pg, 'name')).toBe('"name"')
  })
})

describe('qualifiedTable', () => {
  it('qualifies with the database on MySQL', () => {
    expect(qualifiedTable(mysql, 'app', 'users')).toBe('`app`.`users`')
  })

  it('quotes each part separately on Postgres so the dot stays outside the quotes', () => {
    expect(qualifiedTable(pg, 'app', 'sales.orders')).toBe('"sales"."orders"')
  })

  it('quotes an unqualified Postgres table on its own', () => {
    expect(qualifiedTable(pg, 'app', 'users')).toBe('"users"')
  })
})

describe('quoteValue', () => {
  it('doubles single quotes on Postgres', () => {
    expect(quoteValue(pg, "O'Brien")).toBe("'O''Brien'")
  })

  it('backslash-escapes quotes and backslashes on MySQL', () => {
    expect(quoteValue(mysql, "O'Brien")).toBe("'O\\'Brien'")
    expect(quoteValue(mysql, 'back\\slash')).toBe("'back\\\\slash'")
  })

  it('escapes the backslash before the quote so the quote stays escaped', () => {
    expect(quoteValue(mysql, "a\\'b")).toBe("'a\\\\\\'b'")
  })
})
