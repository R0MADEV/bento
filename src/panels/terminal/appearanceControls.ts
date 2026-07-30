import { t as i18nT } from '../../i18n'
import { getTheme, themeNames, themeLabels } from '../../core/terminal/themes'
import { icon } from '../../ui/icons'

export interface TerminalAppearanceControls {
  popover: HTMLDivElement
  themeButton: HTMLButtonElement
  shellSelect: HTMLSelectElement
  fontInput: HTMLInputElement
}

interface AppearanceOptions {
  themeName: string
  onThemeSelected: (name: string) => void
  onCustomBackground: (background: string) => void
  onShellChanged: (shell: string) => void
  onFontChanged: (fontFamily: string) => void
}

export function createTerminalAppearanceControls(options: AppearanceOptions): TerminalAppearanceControls {
  const popover = document.createElement('div')
  popover.className = 'term-theme-popover hidden'

  const swatches = document.createElement('div')
  swatches.className = 'term-theme-swatches'
  themeNames.forEach(name => {
    const theme = getTheme(name)
    const swatch = document.createElement('button')
    swatch.className = 'term-theme-swatch'
    swatch.title = themeLabels[name] ?? name
    swatch.style.background = theme.background
    swatch.style.borderColor = theme.blue
    swatch.addEventListener('click', () => {
      options.onThemeSelected(name)
      popover.classList.add('hidden')
    })
    swatches.appendChild(swatch)
  })

  const colorRow = document.createElement('label')
  colorRow.className = 'term-theme-color-row'
  colorRow.textContent = i18nT('terminal.customColor')
  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  colorInput.value = getTheme(options.themeName).background
  colorInput.addEventListener('input', () => options.onCustomBackground(colorInput.value))
  colorRow.appendChild(colorInput)

  const isWin = navigator.platform.includes('Win')
  const shellOptions = isWin
    ? [['auto', i18nT('terminal.autoShell')], ['powershell.exe', 'PowerShell'], ['cmd.exe', 'CMD']]
    : [['auto', i18nT('terminal.autoShell')], ['/bin/zsh', 'zsh'], ['/bin/bash', 'bash'], ['fish', 'fish'], ['/bin/sh', 'sh']]
  const shellRow = document.createElement('div')
  shellRow.className = 'term-theme-color-row'
  const shellLabel = document.createElement('span')
  shellLabel.textContent = i18nT('terminal.shell')
  const shellSelect = document.createElement('select')
  shellSelect.className = 'term-shell-select'
  shellOptions.forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    shellSelect.appendChild(option)
  })
  shellSelect.addEventListener('change', () => options.onShellChanged(shellSelect.value))
  shellRow.append(shellLabel, shellSelect)

  const fontRow = document.createElement('label')
  fontRow.className = 'term-theme-color-row'
  const fontLabel = document.createElement('span')
  fontLabel.textContent = i18nT('common.font')
  const fontInput = document.createElement('input')
  fontInput.className = 'term-font-input'
  fontInput.type = 'text'
  fontInput.placeholder = i18nT('terminal.monospacePlaceholder')
  fontInput.addEventListener('change', () => options.onFontChanged(fontInput.value))
  fontRow.append(fontLabel, fontInput)

  popover.append(swatches, colorRow, shellRow, fontRow)
  popover.addEventListener('click', event => event.stopPropagation())

  const themeButton = document.createElement('button')
  themeButton.className = 'term-theme-btn'
  themeButton.title = i18nT('terminal.changeThisTerminalTheme')
  themeButton.innerHTML = icon('palette')
  themeButton.addEventListener('click', event => {
    event.stopPropagation()
    popover.classList.toggle('hidden')
  })

  return { popover, themeButton, shellSelect, fontInput }
}
