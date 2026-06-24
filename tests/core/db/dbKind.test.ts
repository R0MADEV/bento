import { describe, it, expect } from 'vitest'
import { dbKind } from '../../../src/core/db/dbKind'

describe('dbKind', () => {
  it('classifies known database images', () => {
    expect(dbKind('mysql:8')).toBe('mysql')
    expect(dbKind('mariadb:10.11')).toBe('mariadb')
    expect(dbKind('mongo:7')).toBe('mongodb')
    expect(dbKind('postgres:16')).toBe('postgres')
    expect(dbKind('redis:alpine')).toBe('redis')
  })

  it('handles registry-prefixed images', () => {
    expect(dbKind('bitnami/mysql:latest')).toBe('mysql')
    expect(dbKind('docker.io/library/mongo')).toBe('mongodb')
  })

  it('is case-insensitive', () => {
    expect(dbKind('MySQL:8')).toBe('mysql')
  })

  it('returns null for non-database images', () => {
    expect(dbKind('nginx:latest')).toBeNull()
    expect(dbKind('node:20')).toBeNull()
  })
})
