import { describe, expect, it } from 'vitest'
import { groupNoteEntries, type NoteEntry } from '../../../src/core/notes/noteGroups'
import type { ParsedNote } from '../../../src/core/notes/noteFile'

const note = (over: Partial<ParsedNote> = {}): ParsedNote =>
  ({ title: '', category: '', tags: [], body: '', ...over })

const entry = (name: string, over: Partial<ParsedNote> = {}): NoteEntry =>
  ({ name, note: note(over) })

describe('grouping', () => {
  it('buckets entries under their category', () => {
    const groups = groupNoteEntries([
      entry('a', { category: 'Work' }),
      entry('b', { category: 'Personal' }),
      entry('c', { category: 'Work' }),
    ], '', 'Uncategorized')
    expect(groups.map(g => g.category)).toEqual(['Work', 'Personal'])
    expect(groups[0].items.map(e => e.name)).toEqual(['a', 'c'])
  })

  it('falls back to the placeholder category for a blank or whitespace one', () => {
    const groups = groupNoteEntries([entry('a', { category: '  ' })], '', 'Uncategorized')
    expect(groups[0].category).toBe('Uncategorized')
  })

  it('keeps categories in the order they first appear', () => {
    const groups = groupNoteEntries([
      entry('a', { category: 'Z' }),
      entry('b', { category: 'A' }),
    ], '', 'Uncategorized')
    expect(groups.map(g => g.category)).toEqual(['Z', 'A'])
  })

  it('groups nothing into nothing', () => {
    expect(groupNoteEntries([], '', 'Uncategorized')).toEqual([])
  })
})

describe('filtering by search', () => {
  const entries = [
    entry('a', { title: 'Shopping list', category: 'Home', tags: [] }),
    entry('b', { title: 'Meeting notes', category: 'Work', tags: ['urgent'] }),
    entry('c', { title: 'Untitled', category: 'Home', tags: ['recipe'] }),
  ]

  it('keeps everything for an empty query', () => {
    const groups = groupNoteEntries(entries, '', 'Uncategorized')
    expect(groups.flatMap(g => g.items)).toHaveLength(3)
  })

  it('matches the title, case-insensitively', () => {
    const groups = groupNoteEntries(entries, 'SHOPPING', 'Uncategorized')
    expect(groups.flatMap(g => g.items).map(e => e.name)).toEqual(['a'])
  })

  it('matches the category', () => {
    const groups = groupNoteEntries(entries, 'work', 'Uncategorized')
    expect(groups.flatMap(g => g.items).map(e => e.name)).toEqual(['b'])
  })

  it('matches a tag', () => {
    const groups = groupNoteEntries(entries, 'recipe', 'Uncategorized')
    expect(groups.flatMap(g => g.items).map(e => e.name)).toEqual(['c'])
  })

  it('drops a category left with no matches', () => {
    const groups = groupNoteEntries(entries, 'urgent', 'Uncategorized')
    expect(groups.map(g => g.category)).toEqual(['Work'])
  })

  it('can match nothing', () => {
    expect(groupNoteEntries(entries, 'nothing here', 'Uncategorized')).toEqual([])
  })
})
