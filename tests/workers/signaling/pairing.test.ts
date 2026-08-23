import { describe, expect, it } from 'vitest'
import { answerKey, generatePairingCode, isValidPairingCode, offerKey } from '../../../workers/signaling/src/pairing'

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
  it('namespace offer/answer keys by code, distinct from each other', () => {
    const code = '482913'
    const keys = [offerKey(code), answerKey(code)]
    expect(new Set(keys).size).toBe(2)
    for (const key of keys) expect(key).toContain(code)
  })
})
