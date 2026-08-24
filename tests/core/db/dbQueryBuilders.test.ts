import { describe, expect, it } from 'vitest'
import { buildJoinQuery, buildRelationQuery, exampleQuery, groupRelations, quoteIdentifier, type ForeignKey } from '../../../src/core/db/queryBuilders'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (kind: DbServer['kind']): DbServer => ({ kind, source: 'local', host: '127.0.0.1', port: 1 })

describe('database query builders', () => {
  it('quotes identifiers according to the engine', () => {
    expect(quoteIdentifier(server('postgres'), 'public.Users')).toBe('"public"."Users"')
    expect(quoteIdentifier(server('mysql'), 'Users')).toBe('`Users`')
  })

  it('builds engine-specific example queries', () => {
    expect(exampleQuery(server('mongodb'), 'users')).toContain('find()')
    expect(exampleQuery(server('redis'), 'session')).toBe('GET session')
    expect(exampleQuery(server('mysql'), 'users')).toContain('SELECT * FROM')
  })

  it('groups relations and builds deterministic joins', () => {
    const relations: ForeignKey[] = [{ table: 'orders', column: 'user_id', ref_table: 'users', ref_column: 'id' }]
    expect(groupRelations(relations).get('orders')).toEqual(relations)
    expect(buildRelationQuery(server('mysql'), 'orders', relations)).toContain('JOIN')
    expect(buildJoinQuery(server('mysql'), {
      base: 'orders',
      steps: [{ from: 'orders', to: 'users', fromCol: 'user_id', toCol: 'id' }],
    })).toContain('JOIN')
  })
})
