// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandPalette } from '../../src/ui/commandPalette'
import { makeLocalStorage } from '../helpers/localStorage'

describe('command palette view', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    localStorage.setItem('bento.locale', 'en')
  })

  it('uses dialog/listbox semantics and renders command text without interpreting HTML', () => {
    const palette = createCommandPalette(() => [{ id: 'unsafe', label: '<img src=x onerror=alert(1)>', run: vi.fn() }])
    document.body.appendChild(palette)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))

    expect(palette.getAttribute('role')).toBe('dialog')
    expect(palette.getAttribute('aria-label')).toBe('Command palette')
    expect(palette.querySelector('[role="listbox"]')).not.toBeNull()
    expect(palette.querySelector('[role="option"]')?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(palette.querySelector('img')).toBeNull()
  })
})
