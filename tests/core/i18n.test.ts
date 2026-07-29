import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appT, getAppLocale, setAppLocale } from '../../src/core/i18n'

describe('application i18n', () => {
  const values = new Map<string, string>()

  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.stubGlobal('navigator', { language: 'es-ES' })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public options: unknown) {} })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('uses the operating-system language by default', () => {
    expect(getAppLocale()).toBe('es')
    expect(appT('newSession')).toBe('Nueva sesión')
  })

  it('stores one locale for the entire application', () => {
    setAppLocale('en')
    expect(getAppLocale()).toBe('en')
    expect(appT('newTasks')).toBe('New Tasks panel')
  })

  it('interpolates translated values', () => {
    setAppLocale('en')
    expect(appT('goTo', { name: 'Backend' })).toBe('Go to Backend')
  })
})
