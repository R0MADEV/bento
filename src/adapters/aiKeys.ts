import { invoke } from '@tauri-apps/api/core'

// AI API keys stored in the Vault (AES-256-GCM + master password).
// Each provider is an entry: service = 'Bento AI', username = <providerId>.
// Requires the Vault unlocked (like the rest of the secrets).

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

// vault_list fails if locked → we return undefined without breaking.
async function findEntry(provider: string): Promise<VaultEntryPublic | undefined> {
  const entries = await invoke<VaultEntryPublic[]>('vault_list').catch(() => [] as VaultEntryPublic[])
  return entries.find(e => e.service === SERVICE && e.username === provider)
}

export async function getAiKey(provider: string): Promise<string> {
  const entry = await findEntry(provider)
  if (!entry) return ''
  return invoke<string>('vault_get_password', { id: entry.id }).catch(() => '')
}

// Saves/updates the provider's key in the Vault (an empty key deletes it).
// Returns false if it couldn't (e.g. Vault locked).
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
