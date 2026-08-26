import { describe, expect, it } from 'vitest'
import { parseStructuredJson } from '../../../src/core/db/jsonValues'

describe('database JSON values', () => {
  it('formats JSON objects and provides a compact preview', () => {
    expect(parseStructuredJson('{"name":"Bento","active":true}')).toEqual({
      formatted: '{\n  "name": "Bento",\n  "active": true\n}',
      kind: 'object',
      size: 2,
    })
  })

  it('formats JSON arrays', () => {
    expect(parseStructuredJson('[1,{"nested":true}]')).toEqual({
      formatted: '[\n  1,\n  {\n    "nested": true\n  }\n]',
      kind: 'array',
      size: 2,
    })
  })

  it('leaves scalar, invalid, and regular text values alone', () => {
    expect(parseStructuredJson('42')).toBeNull()
    expect(parseStructuredJson('null')).toBeNull()
    expect(parseStructuredJson('{not json}')).toBeNull()
    expect(parseStructuredJson('ordinary text')).toBeNull()
  })

  it('shows badge for backend-truncated JSON (ends with …)', () => {
    expect(parseStructuredJson('{"key": "value", "incomplete…')).toEqual({
      formatted: '{"key": "value", "incomplete…',
      kind: 'object',
      size: -1,
      truncated: true,
    })
    expect(parseStructuredJson('[1, 2, {broken…')).toEqual({
      formatted: '[1, 2, {broken…',
      kind: 'array',
      size: -1,
      truncated: true,
    })
  })
})
