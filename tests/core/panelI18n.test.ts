// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppLocale } from '../../src/core/i18n'
import { localizePanel } from '../../src/core/panelI18n'

describe('panel i18n', () => {
  const values = new Map<string, string>()
  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('translates controls and dynamic status labels without changing user content', async () => {
    setAppLocale('en')
    const root = document.createElement('div')
    const button = Object.assign(document.createElement('button'), { textContent: 'Guardar', title: 'Eliminar' })
    const userContent = Object.assign(document.createElement('article'), { textContent: 'Guardar' })
    root.append(button, userContent)
    const dispose = localizePanel(root)
    expect(button.textContent).toBe('Save')
    expect(button.title).toBe('Delete')
    expect(userContent.textContent).toBe('Guardar')

    const status = Object.assign(document.createElement('div'), { className: 'panel-status', textContent: 'Cargando…' })
    root.appendChild(status)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(status.textContent).toBe('Loading…')
    dispose()
  })
})
