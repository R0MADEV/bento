import { beforeEach, describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { addProfile, loadProfiles, loadProfilesFromStore, removeProfile, requestProfile, saveProfiles, takeRequestedProfile } from '../../../src/core/terminal/profiles'

const makeLocalStorage = () => {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

// El almacén compartido con el daemon, como lo ven los comandos.
function fakeStore(initial: unknown[] = []) {
  let saved = [...initial]
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'terminal_profiles_get') return saved
    if (cmd === 'terminal_profiles_set') { saved = (args as { profiles: unknown[] }).profiles; return null }
    return null
  })
  return () => saved
}

const dev = { name: 'Dev', shell: '/bin/zsh', theme: 'tokyo-night', fontSize: 14 }

describe('profiles', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.stubGlobal('localStorage', makeLocalStorage())
    fakeStore()
  })

  it('sin perfiles guardados no hay ninguno', async () => {
    await loadProfilesFromStore()
    expect(loadProfiles()).toEqual([])
  })

  it('lee los que hay en el almacén compartido', async () => {
    fakeStore([{ id: 'a', ...dev }])

    await loadProfilesFromStore()

    expect(loadProfiles()).toEqual([{ id: 'a', ...dev }])
  })

  it('lo que se añade aquí lo ve el daemon, que es quien abre desde el móvil', async () => {
    const saved = fakeStore()
    await loadProfilesFromStore()

    const added = addProfile(dev)

    expect(added).toMatchObject(dev)
    expect(saved()).toEqual([added])
  })

  it('borrar quita el que dices y deja el resto', async () => {
    const saved = fakeStore()
    await loadProfilesFromStore()
    const a = addProfile(dev)
    const b = addProfile({ name: 'Prod', shell: '/bin/bash', theme: 'black', fontSize: 12 })

    removeProfile(a.id)

    expect(loadProfiles()).toEqual([b])
    expect(saved()).toEqual([b])
  })

  it('se lleva una vez lo que hubiera en el navegador y lo borra de allí', async () => {
    // Los perfiles de antes de que hubiera almacén no se pierden; y al
    // borrarlos de aquí no resucitan en el siguiente arranque.
    localStorage.setItem('bento.terminal.profiles', JSON.stringify([{ id: 'viejo', ...dev }]))
    const saved = fakeStore()

    await loadProfilesFromStore()

    expect(loadProfiles()).toEqual([{ id: 'viejo', ...dev }])
    expect(saved()).toEqual([{ id: 'viejo', ...dev }])
    expect(localStorage.getItem('bento.terminal.profiles')).toBeNull()
  })

  it('un almacén que no responde son cero perfiles, no un panel roto', async () => {
    mocks.invoke.mockImplementation(async () => { throw new Error('sin daemon') })

    await loadProfilesFromStore()

    expect(loadProfiles()).toEqual([])
  })

  it('guardar la lista entera la deja como esté', async () => {
    const saved = fakeStore()
    await loadProfilesFromStore()

    saveProfiles([{ id: 'a', ...dev }])

    expect(loadProfiles()).toEqual([{ id: 'a', ...dev }])
    expect(saved()).toEqual([{ id: 'a', ...dev }])
  })
})

describe('el perfil que pide la paleta', () => {
  beforeEach(() => { fakeStore() })

  it('lo recoge la siguiente terminal que se abre, una sola vez', async () => {
    fakeStore([{ id: 'a', ...dev }])
    await loadProfilesFromStore()

    requestProfile('a')

    // La paleta pide "Terminal: Dev" y la terminal que nace lo aplica; la
    // siguiente ya no, o abriría con un perfil que nadie pidió.
    expect(takeRequestedProfile()).toEqual({ id: 'a', ...dev })
    expect(takeRequestedProfile()).toBeNull()
  })

  it('un perfil que ya no existe no pide nada', async () => {
    await loadProfilesFromStore()

    requestProfile('borrado')

    expect(takeRequestedProfile()).toBeNull()
  })
})
