import { describe, it, expect } from 'vitest'
import { parseHeaders, prettyBody, addHeaderLine } from '../../../src/core/http/httpRequest'

describe('parseHeaders', () => {
  it('parses "Key: Value" lines into pairs', () => {
    expect(parseHeaders('Content-Type: application/json\nAuthorization: Bearer x')).toEqual([
      ['Content-Type', 'application/json'],
      ['Authorization', 'Bearer x'],
    ])
  })

  it('splits on the first colon only', () => {
    expect(parseHeaders('X-Time: 10:30:00')).toEqual([['X-Time', '10:30:00']])
  })

  it('trims keys and values and skips blank or invalid lines', () => {
    expect(parseHeaders('  A : 1 \n\nnope\nB:2')).toEqual([['A', '1'], ['B', '2']])
  })

  it('returns [] for empty input', () => {
    expect(parseHeaders('')).toEqual([])
  })
})

describe('prettyBody', () => {
  it('pretty-prints valid JSON', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  it('returns non-JSON unchanged', () => {
    expect(prettyBody('<html>hi</html>')).toBe('<html>hi</html>')
  })

  it('returns empty string unchanged', () => {
    expect(prettyBody('')).toBe('')
  })
})

describe('addHeaderLine', () => {
  it('adds a header to empty text', () => {
    expect(addHeaderLine('', 'Accept: application/json')).toBe('Accept: application/json')
  })

  it('appends on a new line', () => {
    expect(addHeaderLine('A: 1', 'B: 2')).toBe('A: 1\nB: 2')
  })

  it('does not duplicate a header that already exists (case-insensitive key)', () => {
    expect(addHeaderLine('content-type: text/plain', 'Content-Type: application/json'))
      .toBe('content-type: text/plain')
  })
})
