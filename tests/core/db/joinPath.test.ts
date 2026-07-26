import { describe, it, expect } from 'vitest'
import { buildJoinPath, type Relation } from '../../../src/core/db/joinPath'

const rel = (table: string, column: string, refTable: string, refColumn = 'id'): Relation =>
  ({ table, column, refTable, refColumn })

describe('buildJoinPath', () => {
  it('returns just the base for a single table', () => {
    expect(buildJoinPath(['orders'], [])).toEqual({ base: 'orders', steps: [] })
  })

  it('returns null for no tables', () => {
    expect(buildJoinPath([], [])).toBeNull()
  })

  it('joins two directly related tables (in either FK direction)', () => {
    const rels = [rel('orders', 'user_id', 'users')]
    const plan = buildJoinPath(['orders', 'users'], rels)
    expect(plan).toEqual({
      base: 'orders',
      steps: [{ from: 'orders', fromCol: 'user_id', to: 'users', toCol: 'id' }],
    })
  })

  it('joins from the referenced side too (base is the parent table)', () => {
    const rels = [rel('orders', 'user_id', 'users')]
    const plan = buildJoinPath(['users', 'orders'], rels)
    expect(plan?.base).toBe('users')
    expect(plan?.steps).toEqual([{ from: 'users', fromCol: 'id', to: 'orders', toCol: 'user_id' }])
  })

  it('connects two tables through an intermediate (adds the bridge table)', () => {
    // users ← orders → products : to join users+products we pass through orders
    const rels = [rel('orders', 'user_id', 'users'), rel('orders', 'product_id', 'products')]
    const plan = buildJoinPath(['users', 'products'], rels)
    const tables = plan ? [plan.base, ...plan.steps.map(s => s.to)] : []
    expect(tables).toContain('users')
    expect(tables).toContain('orders')
    expect(tables).toContain('products')
  })

  it('returns null when the tables cannot be connected', () => {
    const rels = [rel('orders', 'user_id', 'users')]
    expect(buildJoinPath(['users', 'unrelated'], rels)).toBeNull()
  })

  it('joins three tables that share a hub', () => {
    const rels = [
      rel('orders', 'user_id', 'users'),
      rel('orders', 'product_id', 'products'),
    ]
    const plan = buildJoinPath(['orders', 'users', 'products'], rels)
    expect(plan?.base).toBe('orders')
    expect(plan?.steps.map(s => s.to).sort()).toEqual(['products', 'users'])
  })
})
