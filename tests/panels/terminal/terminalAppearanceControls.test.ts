// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTerminalAppearanceControls } from '../../../src/panels/terminal/appearanceControls'
import { themeNames } from '../../../src/core/terminal/themes'

describe('terminal appearance controls', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
  })

  it('renders theme, shell and font controls with explicit callbacks', () => {
    const onThemeSelected = vi.fn()
    const onCustomBackground = vi.fn()
    const onShellChanged = vi.fn()
    const onFontChanged = vi.fn()
    const controls = createTerminalAppearanceControls({
      themeName: themeNames[0],
      onThemeSelected,
      onCustomBackground,
      onShellChanged,
      onFontChanged,
    })

    expect(controls.popover.querySelectorAll('.term-theme-swatch')).toHaveLength(themeNames.length)
    expect(controls.shellSelect.options.length).toBeGreaterThan(0)

    ;(controls.popover.querySelector('.term-theme-swatch') as HTMLButtonElement).click()
    expect(onThemeSelected).toHaveBeenCalled()

    controls.shellSelect.value = controls.shellSelect.options[0].value
    controls.shellSelect.dispatchEvent(new Event('change'))
    expect(onShellChanged).toHaveBeenCalledWith(controls.shellSelect.value)

    controls.fontInput.value = 'Fira Code'
    controls.fontInput.dispatchEvent(new Event('change'))
    expect(onFontChanged).toHaveBeenCalledWith('Fira Code')
  })
})
