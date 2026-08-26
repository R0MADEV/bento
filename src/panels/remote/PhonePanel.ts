import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/helpers/icons'
import QRCode from 'qrcode'
import { t as i18nT } from '../../i18n'

interface RemoteStatus {
  running: boolean
  url?: string
  token?: string
  addr?: string
}

const PORT_KEY       = 'bento.remote.port'
const TOKEN_KEY      = 'bento.remote.token'
const TAILSCALE_KEY  = 'bento.remote.tailscale'

// Session-scoped: survives panel close/reopen within the same Bento session.
// true = user explicitly stopped the server; init() won't auto-restart until
// the user clicks ON again.
let sessionStopped = false

export function createPhonePanel(): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'phone-panel'

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div')
  header.className = 'phone-header'
  header.innerHTML = icon('phone') + '<span>Control desde el móvil</span>'
  root.append(header)

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div')
  body.className = 'phone-body'
  root.append(body)

  // Toggle
  const toggleLabel = document.createElement('label')
  toggleLabel.className = 'phone-toggle-row'
  const toggleInput = document.createElement('input')
  toggleInput.type = 'checkbox'
  const toggleText = document.createElement('span')
  toggleText.textContent = i18nT('remote.enableWifiServer')
  toggleLabel.append(toggleInput, toggleText)

  // Tailscale toggle (hidden until tailscale_detect confirms it's available)
  const tsLabel = document.createElement('label')
  tsLabel.className = 'phone-toggle-row hidden'
  const tsToggle = document.createElement('input')
  tsToggle.type = 'checkbox'
  // Opt-out: checked unless user explicitly set to 'false'
  tsToggle.checked = localStorage.getItem(TAILSCALE_KEY) !== 'false'
  const tsText = document.createElement('span')
  tsText.textContent = i18nT('remote.useTailscale')
  tsLabel.append(tsToggle, tsText)
  tsToggle.onchange = async () => {
    // Store 'false' explicitly when disabled; absence or 'true' means enabled
    localStorage.setItem(TAILSCALE_KEY, tsToggle.checked ? 'true' : 'false')
    if (toggleInput.checked) {
      clearError()
      toggleInput.disabled = true
      tsToggle.disabled = true
      try {
        await invoke('remote_stop')
        await startServer()
      } catch (e) {
        showError(`Error: ${String(e)}`)
      } finally {
        toggleInput.disabled = false
        tsToggle.disabled = false
      }
    }
  }

  // Port
  const portRow = document.createElement('div')
  portRow.className = 'phone-port-row'
  const portLabel = document.createElement('span')
  portLabel.textContent = i18nT('remote.port')
  const portInput = document.createElement('input')
  portInput.type = 'number'
  portInput.className = 'phone-port-input'
  portInput.min = '1024'
  portInput.max = '65535'
  portInput.value = localStorage.getItem(PORT_KEY) ?? '7879'
  portRow.append(portLabel, portInput)

  body.append(toggleLabel, tsLabel, portRow)

  // ── Active section ────────────────────────────────────────────────────────
  const activeSection = document.createElement('div')
  activeSection.className = 'phone-active hidden'

  const urlRow = document.createElement('div')
  urlRow.className = 'phone-url-row'
  const urlCode = document.createElement('code')
  urlCode.className = 'phone-url'
  const copyBtn = document.createElement('button')
  copyBtn.className = 'phone-copy-btn'
  copyBtn.innerHTML = icon('copy') + ' Copiar'
  copyBtn.onclick = () => {
    const text = urlCode.textContent
    if (text) void navigator.clipboard.writeText(text)
  }
  urlRow.append(urlCode, copyBtn)

  const qrImg = document.createElement('img')
  qrImg.className = 'phone-qr'
  qrImg.alt = 'QR de conexión'

  const warn = document.createElement('p')
  warn.className = 'phone-warn'

  activeSection.append(urlRow, qrImg, warn)
  body.append(activeSection)

  // ── Error ─────────────────────────────────────────────────────────────────
  const errorEl = document.createElement('p')
  errorEl.className = 'phone-error hidden'
  body.append(errorEl)

  // ── Desc ──────────────────────────────────────────────────────────────────
  const desc = document.createElement('p')
  desc.className = 'phone-desc'
  desc.textContent = i18nT('remote.howItWorks')
  body.append(desc)

  const showError = (msg: string): void => {
    errorEl.textContent = msg
    errorEl.classList.remove('hidden')
  }
  const clearError = (): void => errorEl.classList.add('hidden')

  // ── Render ────────────────────────────────────────────────────────────────
  const render = async (s: RemoteStatus): Promise<void> => {
    toggleInput.checked = s.running
    portInput.disabled = s.running
    toggleText.textContent = s.running ? i18nT('remote.serverRunning') : i18nT('remote.enableWifiServer')
    if (s.running && s.url) {
      urlCode.textContent = s.url
      try {
        qrImg.src = await QRCode.toDataURL(s.url, { width: 220, margin: 2, color: { dark: '#e2e8f8', light: '#0e0e1c' } })
      } catch { /* ignore */ }
      warn.textContent = tsToggle.checked
        ? i18nT('remote.reachableViaTailscale')
        : i18nT('remote.localWifiOnly')
      activeSection.classList.remove('hidden')
    } else {
      activeSection.classList.add('hidden')
    }
  }

  const startServer = async (): Promise<void> => {
    sessionStopped = false
    const port = parseInt(portInput.value) || 7879
    localStorage.setItem(PORT_KEY, String(port))
    const savedToken = localStorage.getItem(TOKEN_KEY) ?? undefined
    const useTailscale = tsToggle.checked
    const s = await invoke<RemoteStatus>('remote_start', { port, token: savedToken, useTailscale })
    if (s.token) localStorage.setItem(TOKEN_KEY, s.token)
    await render(s)
  }

  const stopServer = async (): Promise<void> => {
    sessionStopped = true
    await invoke('remote_stop')
    await render({ running: false })
  }

  // ── Init: poll until daemon is reachable, then auto-start once per session ─
  const RETRY_DELAYS = [300, 600, 1200, 2000, 3000]
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let userInteracted = false

  const cancelRetries = (): void => {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
  }

  const init = async (attempt = 0): Promise<void> => {
    if (userInteracted) return
    toggleText.textContent = i18nT('remote.checking')
    toggleInput.disabled = true
    try {
      const [s, tsIp] = await Promise.all([
        invoke<RemoteStatus>('remote_status'),
        invoke<string | null>('tailscale_detect').catch(() => null),
      ])
      if (userInteracted) return
      toggleInput.disabled = false
      if (tsIp) {
        tsLabel.classList.remove('hidden')
      }
      if (s.running) {
        await render(s)
      } else if (!sessionStopped) {
        // Auto-start once per session (user hasn't explicitly stopped it)
        await startServer()
      } else {
        await render({ running: false })
      }
    } catch {
      if (userInteracted) return
      if (attempt < RETRY_DELAYS.length) {
        retryTimer = setTimeout(() => void init(attempt + 1), RETRY_DELAYS[attempt])
      } else {
        toggleInput.disabled = false
        await render({ running: false })
      }
    }
  }

  toggleInput.onchange = async () => {
    userInteracted = true
    cancelRetries()
    clearError()
    toggleInput.disabled = true
    toggleText.textContent = toggleInput.checked ? i18nT('remote.starting') : i18nT('remote.stopping')
    try {
      if (toggleInput.checked) {
        await startServer()
      } else {
        await stopServer()
      }
    } catch (e) {
      showError(`Error: ${String(e)}`)
      toggleInput.checked = !toggleInput.checked
      toggleText.textContent = toggleInput.checked ? i18nT('remote.serverRunning') : i18nT('remote.enableWifiServer')
    } finally {
      toggleInput.disabled = false
    }
  }

  void init()

  return { element: root }
}
