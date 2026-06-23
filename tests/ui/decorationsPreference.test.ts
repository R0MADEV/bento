import { beforeEach, describe, it, expect, vi } from 'vitest'
import { getDecorations, setDecorations } from '../../src/ui/decorationsPreference'

const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

describe('decorationsPreference', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  it('defaults to true when no value is saved', () => {
    expect(getDecorations()).toBe(true)
  })

  it('returns false after setDecorations(false)', () => {
    setDecorations(false)
    expect(getDecorations()).toBe(false)
  })

  it('returns true after setDecorations(true)', () => {
    setDecorations(false)
    setDecorations(true)
    expect(getDecorations()).toBe(true)
  })
})
