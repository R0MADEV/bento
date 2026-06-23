import { describe, it, expect } from 'vitest'
import { addBookmark, removeBookmark, isBookmarked, groupBookmarks, type Bookmark } from '../../../src/core/web/bookmarks'

const bm = (id: string, url: string, group: string): Bookmark => ({ id, url, title: url, group })

describe('addBookmark', () => {
  it('appends a bookmark', () => {
    const b = addBookmark([], bm('1', 'https://a.com', 'API'))
    expect(b).toHaveLength(1)
  })

  it('replaces a bookmark with the same id', () => {
    const b0 = [bm('1', 'https://a.com', 'API')]
    const b = addBookmark(b0, bm('1', 'https://a.com', 'Web'))
    expect(b).toHaveLength(1)
    expect(b[0].group).toBe('Web')
  })
})

describe('removeBookmark', () => {
  it('removes by id', () => {
    const b0 = [bm('1', 'https://a.com', 'API'), bm('2', 'https://b.com', 'API')]
    expect(removeBookmark(b0, '1').map(b => b.id)).toEqual(['2'])
  })
})

describe('isBookmarked', () => {
  const b0 = [bm('1', 'https://a.com', 'API')]
  it('is true when a bookmark with the url exists', () => {
    expect(isBookmarked(b0, 'https://a.com')).toBe(true)
  })
  it('is false otherwise', () => {
    expect(isBookmarked(b0, 'https://x.com')).toBe(false)
  })
})

describe('groupBookmarks', () => {
  it('groups by group preserving insertion order', () => {
    const b0 = [
      bm('1', 'https://a.com', 'API'),
      bm('2', 'https://b.com', 'Web'),
      bm('3', 'https://c.com', 'API'),
    ]
    const groups = groupBookmarks(b0)
    expect(groups.map(g => g.group)).toEqual(['API', 'Web'])
    expect(groups[0].items.map(b => b.id)).toEqual(['1', '3'])
  })
})
