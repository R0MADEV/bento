import { describe, it, expect } from 'vitest'
import { addHistory, searchHistory } from '../../../src/core/web/history'

describe('addHistory', () => {
  it('prepends a new entry', () => {
    const h = addHistory([], 'https://a.com', 1000)
    expect(h).toEqual([{ url: 'https://a.com', visitedAt: 1000 }])
  })

  it('moves an existing url to the front without duplicating', () => {
    const h0 = [
      { url: 'https://a.com', visitedAt: 1 },
      { url: 'https://b.com', visitedAt: 2 },
    ]
    const h = addHistory(h0, 'https://a.com', 3)
    expect(h.map(e => e.url)).toEqual(['https://a.com', 'https://b.com'])
    expect(h[0].visitedAt).toBe(3)
  })

  it('caps the history at the limit, dropping the oldest', () => {
    const h0 = [{ url: 'https://keep.com', visitedAt: 1 }]
    const h = addHistory(h0, 'https://new.com', 2, 1)
    expect(h.map(e => e.url)).toEqual(['https://new.com'])
  })
})

describe('searchHistory', () => {
  const history = [
    { url: 'https://github.com/foo', visitedAt: 3 },
    { url: 'https://gitlab.com/bar', visitedAt: 2 },
    { url: 'https://example.com', visitedAt: 1 },
  ]

  it('returns [] for an empty query', () => {
    expect(searchHistory(history, '  ')).toEqual([])
  })

  it('matches a substring case-insensitively', () => {
    expect(searchHistory(history, 'GIT').map(e => e.url)).toEqual([
      'https://github.com/foo',
      'https://gitlab.com/bar',
    ])
  })

  it('caps the number of suggestions', () => {
    expect(searchHistory(history, 'git', 1)).toHaveLength(1)
  })
})
