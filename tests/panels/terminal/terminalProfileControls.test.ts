// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createTerminalProfileControls } from '../../../src/panels/terminal/profileControls'
import { loadProfilesFromStore } from '../../../src/core/terminal/profiles'

describe('terminal profile controls', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    mocks.invoke.mockImplementation(async () => [])
  })

  it('guarda los ajustes de ahora como un perfil nuevo', async () => {
    await loadProfilesFromStore()
    const getSettings = vi.fn(() => ({ shell: '/bin/sh', theme: 'dark', fontSize: 13 }))
    vi.stubGlobal('prompt', () => 'Work')
    const controls = createTerminalProfileControls({ getSettings, onSelect: vi.fn() })

    controls.element.querySelector<HTMLButtonElement>('.term-profile-save')!.click()

    expect(getSettings).toHaveBeenCalledOnce()
    expect(controls.element.querySelector('.term-profile-name')?.textContent).toBe('Work')
  })

  it('aplica el perfil que pulsas, venga de donde venga', async () => {
    // Los perfiles salen del almacén compartido: uno creado desde otro sitio
    // aparece aquí igual.
    const profile = { id: 'profile-1', name: 'Saved', shell: '/bin/bash', theme: 'light', fontSize: 14 }
    mocks.invoke.mockImplementation(async () => [profile])
    await loadProfilesFromStore()
    const onSelect = vi.fn()
    const controls = createTerminalProfileControls({ getSettings: vi.fn(() => ({ shell: '', theme: '', fontSize: 13 })), onSelect })

    controls.element.querySelector<HTMLButtonElement>('.term-profile-name')!.click()

    expect(onSelect).toHaveBeenCalledWith(profile)
  })
})
