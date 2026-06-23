import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { loadProfiles, saveProfiles, addProfile, removeProfile } from '../../../src/core/terminal/profiles'

const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

describe('profiles', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loadProfiles returns [] when storage is empty', () => {
    expect(loadProfiles()).toEqual([])
  })

  it('loadProfiles returns [] on invalid JSON without throwing', () => {
    localStorage.setItem('bento.terminal.profiles', '{not json')
    expect(loadProfiles()).toEqual([])
  })

  it('saveProfiles / loadProfiles round-trips', () => {
    const profiles = [{ id: 'a', name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 }]
    saveProfiles(profiles)
    expect(loadProfiles()).toEqual(profiles)
  })

  it('addProfile appends and returns the new profile', () => {
    const added = addProfile({ name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 })
    expect(added).toMatchObject({ name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 })
    expect(typeof added.id).toBe('string')
    expect(added.id.length).toBeGreaterThan(0)
    expect(loadProfiles()).toHaveLength(1)
    expect(loadProfiles()[0]).toEqual(added)
  })

  it('addProfile appends to existing profiles', () => {
    addProfile({ name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 })
    addProfile({ name: 'Prod', shell: '/bin/bash', theme: 'black', fontSize: 12 })
    expect(loadProfiles()).toHaveLength(2)
  })

  it('removeProfile removes the matching profile', () => {
    vi.setSystemTime(1000)
    const a = addProfile({ name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 })
    vi.setSystemTime(2000)
    const b = addProfile({ name: 'Prod', shell: '/bin/bash', theme: 'black', fontSize: 12 })
    removeProfile(a.id)
    const remaining = loadProfiles()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(b.id)
  })

  it('removeProfile with unknown id leaves profiles unchanged', () => {
    addProfile({ name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 })
    removeProfile('nonexistent')
    expect(loadProfiles()).toHaveLength(1)
  })
})
