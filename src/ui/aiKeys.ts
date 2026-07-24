import { invoke } from '@tauri-apps/api/core'

// API keys de IA guardadas en el Vault (AES-256-GCM + contraseña maestra).
// Cada proveedor es una entrada: service = 'Bento AI', username = <providerId>.
// Requiere el Vault desbloqueado (igual que el resto de secretos).

const SERVICE = 'Bento AI'

interface VaultEntryPublic {
  id: string
  service: string
  username: string
  url: string
  notes: string
}

export type VaultStatus = 'absent' | 'locked' | 'unlocked'

export async function vaultStatus(): Promise<VaultStatus> {
  const exists = await invoke<boolean>('vault_exists').catch(() => false)
  if (!exists) return 'absent'
  const unlocked = await invoke<boolean>('vault_is_unlocked').catch(() => false)
  return unlocked ? 'unlocked' : 'locked'
}

// vault_list falla si está bloqueado → devolvemos undefined sin romper.
async function findEntry(provider: string): Promise<VaultEntryPublic | undefined> {
  const entries = await invoke<VaultEntryPublic[]>('vault_list').catch(() => [] as VaultEntryPublic[])
  return entries.find(e => e.service === SERVICE && e.username === provider)
}

export async function getAiKey(provider: string): Promise<string> {
  const entry = await findEntry(provider)
  if (!entry) return ''
  return invoke<string>('vault_get_password', { id: entry.id }).catch(() => '')
}

// Guarda/actualiza la key del proveedor en el Vault (una key vacía la borra).
// Devuelve false si no se pudo (p. ej. Vault bloqueado).
export async function setAiKey(provider: string, key: string, baseUrl = ''): Promise<boolean> {
  const entry = await findEntry(provider)
  try {
    if (!key) {
      if (entry) await invoke('vault_delete', { id: entry.id })
      return true
    }
    const fields = { service: SERVICE, username: provider, password: key, url: baseUrl, notes: '' }
    if (entry) await invoke('vault_update', { id: entry.id, ...fields })
    else await invoke('vault_add', fields)
    return true
  } catch {
    return false
  }
}
