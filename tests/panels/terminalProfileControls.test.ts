// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalProfileControls } from '../../src/panels/terminal/profileControls'

describe('terminal profile controls', () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
  })

  it('saves current settings and applies an existing profile', () => {
    const getSettings = vi.fn(() => ({ shell: '/bin/sh', theme: 'dark', fontSize: 13 }))
    const onSelect = vi.fn()
    vi.stubGlobal('prompt', () => 'Work')
    const controls = createTerminalProfileControls({ getSettings, onSelect })

    const saveButton = controls.element.querySelector('.term-profile-save') as HTMLButtonElement
    saveButton.click()
    expect(getSettings).toHaveBeenCalledOnce()
    expect(controls.element.querySelector('.term-profile-name')?.textContent).toBe('Work')

    const profile = { id: 'profile-1', name: 'Saved', shell: '/bin/bash', theme: 'light', fontSize: 14 }
    storage.set('bento.terminal.profiles', JSON.stringify([profile]))
    controls.render()
    controls.element.querySelector<HTMLButtonElement>('.term-profile-name')?.click()
    expect(onSelect).toHaveBeenCalledWith(profile)
  })
})
