import { addProfile, loadProfiles, removeProfile, type TerminalProfile } from '../../core/terminal/profiles'
import { t as i18nT } from '../../i18n'

interface ProfileSettings {
  shell: string
  theme: string
  fontSize: number
  fontFamily?: string
}

interface ProfileControlsOptions {
  getSettings: () => ProfileSettings
  onSelect: (profile: TerminalProfile) => void
}

export function createTerminalProfileControls(options: ProfileControlsOptions): { element: HTMLDivElement; render: () => void } {
  const element = document.createElement('div')
  element.className = 'term-profiles-section'

  const render = (): void => {
    element.replaceChildren()
    const profiles = loadProfiles()
    if (profiles.length) {
      const list = document.createElement('div')
      list.className = 'term-profile-list'
      profiles.forEach(profile => {
        const row = document.createElement('div')
        row.className = 'term-profile-row'
        const nameButton = document.createElement('button')
        nameButton.className = 'term-profile-name'
        nameButton.textContent = profile.name
        nameButton.title = i18nT('terminal.profileDescription', {
          shell: profile.shell,
          theme: profile.theme,
          fontSize: profile.fontSize,
          fontFamily: profile.fontFamily ? ` · ${profile.fontFamily}` : '',
        })
        nameButton.addEventListener('click', () => options.onSelect(profile))

        const deleteButton = document.createElement('button')
        deleteButton.className = 'term-profile-del'
        deleteButton.textContent = '×'
        deleteButton.addEventListener('click', () => {
          removeProfile(profile.id)
          render()
        })
        row.append(nameButton, deleteButton)
        list.appendChild(row)
      })
      element.appendChild(list)
    }

    const saveButton = document.createElement('button')
    saveButton.className = 'term-profile-save'
    saveButton.textContent = i18nT('terminal.saveCurrentProfile')
    saveButton.addEventListener('click', () => {
      const name = prompt(i18nT('terminal.profileName'))
      if (!name?.trim()) return
      addProfile({ name: name.trim(), ...options.getSettings() })
      render()
    })
    element.appendChild(saveButton)
  }

  render()
  return { element, render }
}
