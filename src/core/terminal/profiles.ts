import { invoke } from '@tauri-apps/api/core'

// Los perfiles de terminal viven en el almacén compartido con el daemon
// (`bento_core::profiles`): el shell que eliges aquí es con el que abre el
// móvil. Estaban solo en el navegador, así que fuera de esta app no existían.
//
// En memoria mientras se usan, porque el panel los pinta y leer el almacén por
// cada render sería una llamada por fotograma; escribir sí va al almacén.

export interface TerminalProfile {
  id: string
  name: string
  shell: string
  theme: string
  fontSize: number
  fontFamily?: string
}

const LEGACY_KEY = 'bento.terminal.profiles'

let profiles: TerminalProfile[] = []

/// Trae los perfiles del almacén. Lo que hubiera en el navegador se mueve una
/// vez y se borra de allí, para que borrar un perfil no lo resucite.
export async function loadProfilesFromStore(): Promise<void> {
  profiles = await invoke<TerminalProfile[]>('terminal_profiles_get').catch(() => [])
  if (profiles.length) return
  const legacy = readLegacy()
  if (!legacy.length) return
  profiles = legacy
  await persist()
  localStorage.removeItem(LEGACY_KEY)
}

function readLegacy(): TerminalProfile[] {
  try { return JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]') as TerminalProfile[] }
  catch { return [] }
}

async function persist(): Promise<void> {
  await invoke('terminal_profiles_set', { profiles }).catch(() => {})
}

// El perfil que la paleta pidió para la próxima terminal. La orden y el panel
// que la cumple no se conocen —`addPanel` solo lleva el tipo—, así que el
// encargo se deja aquí y lo recoge quien nazca después. Una sola vez: si se
// quedara puesto, la siguiente terminal abriría con un perfil que nadie pidió.
let requested: string | null = null

export function requestProfile(id: string | null): void {
  requested = id
}

export function takeRequestedProfile(): TerminalProfile | null {
  const id = requested
  requested = null
  return profiles.find(profile => profile.id === id) ?? null
}

export function loadProfiles(): TerminalProfile[] {
  return profiles
}

export function saveProfiles(next: TerminalProfile[]): void {
  profiles = next
  void persist()
}

export function addProfile(p: Omit<TerminalProfile, 'id'>): TerminalProfile {
  // Con la hora como id, dos perfiles creados en el mismo milisegundo salían
  // con el mismo, y borrar uno se llevaba los dos.
  const profile = { ...p, id: crypto.randomUUID() }
  saveProfiles([...profiles, profile])
  return profile
}

export function removeProfile(id: string): void {
  saveProfiles(profiles.filter(p => p.id !== id))
}
