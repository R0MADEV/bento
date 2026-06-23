import { describe, it, expect } from 'vitest'
import { parseNote, serializeNote } from '../../../src/core/notes/noteFile'

describe('parseNote', () => {
  it('parses title, category and tags from frontmatter', () => {
    const md = `---\ntitle: Reunión lunes\ncategory: trabajo\ntags: bento, ideas\n---\nContenido\nlínea 2`
    const n = parseNote(md)
    expect(n.title).toBe('Reunión lunes')
    expect(n.category).toBe('trabajo')
    expect(n.tags).toEqual(['bento', 'ideas'])
    expect(n.body).toBe('Contenido\nlínea 2')
  })

  it('defaults missing fields and treats the whole text as body when there is no frontmatter', () => {
    const n = parseNote('solo texto\nsin meta')
    expect(n.title).toBe('solo texto')
    expect(n.category).toBe('')
    expect(n.tags).toEqual([])
    expect(n.body).toBe('solo texto\nsin meta')
  })

  it('ignores empty tags and trims them', () => {
    const n = parseNote(`---\ntitle: x\ntags: a,  , b ,\n---\n`)
    expect(n.tags).toEqual(['a', 'b'])
  })
})

describe('serializeNote', () => {
  it('writes frontmatter followed by the body', () => {
    const md = serializeNote({ title: 'Hola', category: 'casa', tags: ['x', 'y'], body: 'cuerpo' })
    expect(md).toBe(`---\ntitle: Hola\ncategory: casa\ntags: x, y\n---\ncuerpo`)
  })

  it('round-trips through parseNote', () => {
    const note = { title: 'T', category: 'c', tags: ['a', 'b'], body: 'línea1\nlínea2' }
    expect(parseNote(serializeNote(note))).toEqual(note)
  })
})
