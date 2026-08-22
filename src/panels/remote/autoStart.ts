import { invoke } from '@tauri-apps/api/core'

const PORT_KEY      = 'bento.remote.port'
const TOKEN_KEY     = 'bento.remote.token'
const TAILSCALE_KEY = 'bento.remote.tailscale'

export async function autoStartRemote(): Promise<void> {
  try {
    const port = parseInt(localStorage.getItem(PORT_KEY) ?? '7879') || 7879
    const savedToken = localStorage.getItem(TOKEN_KEY) ?? undefined

    // Use Tailscale if detected, unless the user explicitly disabled it
    const tsIp = await invoke<string | null>('tailscale_detect').catch(() => null)
    const useTailscale = tsIp !== null && localStorage.getItem(TAILSCALE_KEY) !== 'false'

    const result = await invoke<{ token?: string }>('remote_start', {
      port,
      token: savedToken,
      useTailscale,
    })

    if (result.token) localStorage.setItem(TOKEN_KEY, result.token)
    if (useTailscale) localStorage.setItem(TAILSCALE_KEY, 'true')
  } catch {
    // Daemon not yet ready — PhonePanel.init() retries when the panel opens
  }
}
