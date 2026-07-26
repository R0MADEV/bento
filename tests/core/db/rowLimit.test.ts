import { describe, it, expect } from 'vitest'
import { withRowLimit } from '../../../src/core/db/rowLimit'

describe('withRowLimit', () => {
  it('appends a LIMIT to a SELECT without one', () => {
    expect(withRowLimit('SELECT * FROM users', 200)).toBe('SELECT * FROM users\nLIMIT 200')
  })

  it('leaves a SELECT that already has a LIMIT untouched', () => {
    expect(withRowLimit('SELECT * FROM users LIMIT 10', 200)).toBe('SELECT * FROM users LIMIT 10')
  })

  it('detects LIMIT case-insensitively', () => {
    expect(withRowLimit('select * from users limit 5', 200)).toBe('select * from users limit 5')
  })

  it('strips a trailing semicolon before appending', () => {
    expect(withRowLimit('SELECT * FROM users;', 200)).toBe('SELECT * FROM users\nLIMIT 200')
  })

  it('appends after ORDER BY (valid SQL)', () => {
    expect(withRowLimit('SELECT * FROM t ORDER BY id', 50)).toBe('SELECT * FROM t ORDER BY id\nLIMIT 50')
  })

  it('handles WITH ... SELECT (CTE)', () => {
    expect(withRowLimit('WITH x AS (SELECT 1) SELECT * FROM x', 200)).toBe('WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 200')
  })

  it('does not touch non-SELECT statements', () => {
    expect(withRowLimit('UPDATE users SET a = 1', 200)).toBe('UPDATE users SET a = 1')
    expect(withRowLimit('SHOW TABLES', 200)).toBe('SHOW TABLES')
  })

  it('ignores leading whitespace when detecting SELECT', () => {
    expect(withRowLimit('   SELECT 1', 200)).toBe('SELECT 1\nLIMIT 200')
  })
})
