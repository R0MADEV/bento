import { describe, it, expect } from 'vitest'
import { splitLines, deltaFromLine, isDoneLine } from '../../../src/core/ai/sseStream'

describe('splitLines', () => {
  it('returns complete lines and keeps the trailing partial as rest', () => {
    const { lines, rest } = splitLines('a\nb\nhalf')
    expect(lines).toEqual(['a', 'b'])
    expect(rest).toBe('half')
  })

  it('keeps everything as rest when there is no newline yet', () => {
    const { lines, rest } = splitLines('data: {')
    expect(lines).toEqual([])
    expect(rest).toBe('data: {')
  })

  it('yields an empty trailing rest when the buffer ends in a newline', () => {
    const { lines, rest } = splitLines('a\nb\n')
    expect(lines).toEqual(['a', 'b'])
    expect(rest).toBe('')
  })
})

describe('deltaFromLine', () => {
  it('extracts the delta content from an OpenAI SSE data line', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hola"}}]}'
    expect(deltaFromLine(line)).toBe('Hola')
  })

  it('returns null for the [DONE] sentinel', () => {
    expect(deltaFromLine('data: [DONE]')).toBeNull()
  })

  it('returns null for non-data lines (comments, blanks)', () => {
    expect(deltaFromLine('')).toBeNull()
    expect(deltaFromLine(': keep-alive')).toBeNull()
  })

  it('returns null when the delta has no content (e.g. role-only first chunk)', () => {
    expect(deltaFromLine('data: {"choices":[{"delta":{"role":"assistant"}}]}')).toBeNull()
  })

  it('returns null on malformed JSON instead of throwing', () => {
    expect(deltaFromLine('data: {not json')).toBeNull()
  })
})

describe('isDoneLine', () => {
  it('detects the [DONE] sentinel', () => {
    expect(isDoneLine('data: [DONE]')).toBe(true)
    expect(isDoneLine('data:[DONE]')).toBe(true)
  })

  it('is false for content lines', () => {
    expect(isDoneLine('data: {"choices":[]}')).toBe(false)
  })
})
