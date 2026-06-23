export interface TerminalProfile {
  id: string
  name: string
  shell: string
  theme: string
  fontSize: number
}

const KEY = 'bento.terminal.profiles'

export function loadProfiles(): TerminalProfile[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

export function saveProfiles(profiles: TerminalProfile[]): void {
  localStorage.setItem(KEY, JSON.stringify(profiles))
}

export function addProfile(p: Omit<TerminalProfile, 'id'>): TerminalProfile {
  const profiles = loadProfiles()
  const profile = { ...p, id: Date.now().toString(36) }
  saveProfiles([...profiles, profile])
  return profile
}

export function removeProfile(id: string): void {
  saveProfiles(loadProfiles().filter(p => p.id !== id))
}
