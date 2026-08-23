import { describe, expect, it } from 'vitest'
import {
  answerKey,
  appendIceCandidate,
  generatePairingCode,
  iceCandidatesSince,
  iceKey,
  isValidPairingCode,
  offerKey,
} from '../../../workers/signaling/src/pairing'

describe('generatePairingCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generatePairingCode()
    expect(code).toMatch(/^\d{6}$/)
  })

  it('is not the same value on every call', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})

describe('isValidPairingCode', () => {
  it('accepts exactly 6 digits', () => {
    expect(isValidPairingCode('123456')).toBe(true)
  })

  it('rejects wrong length, non-digits, and empty input', () => {
    expect(isValidPairingCode('12345')).toBe(false)
    expect(isValidPairingCode('1234567')).toBe(false)
    expect(isValidPairingCode('12345a')).toBe(false)
    expect(isValidPairingCode('')).toBe(false)
  })
})

describe('KV key builders', () => {
  it('namespace offer/answer/ice keys by code, distinct from each other', () => {
    const code = '482913'
    const keys = [offerKey(code), answerKey(code), iceKey(code)]
    expect(new Set(keys).size).toBe(3)
    for (const key of keys) expect(key).toContain(code)
  })
})

describe('appendIceCandidate', () => {
  it('appends to an empty list', () => {
    expect(appendIceCandidate([], 'candidate-a')).toEqual(['candidate-a'])
  })

  it('preserves existing candidates and order', () => {
    expect(appendIceCandidate(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })
})

describe('iceCandidatesSince', () => {
  it('returns every candidate when since is 0', () => {
    const result = iceCandidatesSince(['a', 'b', 'c'], 0)
    expect(result).toEqual({ candidates: ['a', 'b', 'c'], total: 3 })
  })

  it('returns only candidates added after the given cursor', () => {
    const result = iceCandidatesSince(['a', 'b', 'c'], 1)
    expect(result).toEqual({ candidates: ['b', 'c'], total: 3 })
  })

  it('returns nothing new when the cursor is already caught up', () => {
    const result = iceCandidatesSince(['a', 'b'], 2)
    expect(result).toEqual({ candidates: [], total: 2 })
  })

  it('clamps a cursor beyond the list instead of throwing', () => {
    const result = iceCandidatesSince(['a'], 99)
    expect(result).toEqual({ candidates: [], total: 1 })
  })
})
