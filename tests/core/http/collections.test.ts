import { describe, it, expect } from 'vitest'
import { addCollection, removeCollection, renameCollection, type Collection } from '../../../src/core/http/collections'
import { specTitle } from '../../../src/core/http/openapi'

const col = (id: string, name: string): Collection => ({ id, name, endpoints: [] })

describe('collections', () => {
  it('addCollection appends a collection', () => {
    expect(addCollection([], col('1', 'Petstore'))).toHaveLength(1)
  })

  it('addCollection replaces a collection with the same name (re-import updates it)', () => {
    const list = [col('1', 'Petstore')]
    const next = addCollection(list, { id: '2', name: 'Petstore', endpoints: [{ method: 'GET', url: '/x', summary: '', body: '', headers: '' }] })
    expect(next).toHaveLength(1)
    expect(next[0].endpoints).toHaveLength(1)
  })

  it('removeCollection removes by id', () => {
    expect(removeCollection([col('1', 'A'), col('2', 'B')], '1').map(c => c.id)).toEqual(['2'])
  })

  it('renameCollection changes the name of the matching collection', () => {
    const next = renameCollection([col('1', 'A'), col('2', 'B')], '1', 'Proyecto X')
    expect(next.find(c => c.id === '1')?.name).toBe('Proyecto X')
    expect(next.find(c => c.id === '2')?.name).toBe('B')
  })
})

describe('specTitle', () => {
  it('uses info.title', () => {
    expect(specTitle({ info: { title: 'Swagger Petstore' } })).toBe('Swagger Petstore')
  })

  it('falls back to host, then to "API"', () => {
    expect(specTitle({ host: 'api.example.com' })).toBe('api.example.com')
    expect(specTitle({})).toBe('API')
    expect(specTitle(null)).toBe('API')
  })
})
