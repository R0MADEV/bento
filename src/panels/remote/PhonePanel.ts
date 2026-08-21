import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/icons'
import QRCode from 'qrcode'

interface RemoteStatus {
  running: boolean
  url?: string
  token?: string
  addr?: string
}

const PORT_KEY  = 'bento.remote.port'
const TOKEN_KEY = 'bento.remote.token'

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
  toggleText.textContent = 'Activar servidor WiFi'
  toggleLabel.append(toggleInput, toggleText)

  // Port
  const portRow = document.createElement('div')
  portRow.className = 'phone-port-row'
  const portLabel = document.createElement('span')
  portLabel.textContent = 'Puerto'
  const portInput = document.createElement('input')
  portInput.type = 'number'
  portInput.className = 'phone-port-input'
  portInput.min = '1024'
  portInput.max = '65535'
  portInput.value = localStorage.getItem(PORT_KEY) ?? '7879'
  portRow.append(portLabel, portInput)

  body.append(toggleLabel, portRow)

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
  warn.textContent = 'Solo en tu red WiFi local — nunca exponer a internet.'

  activeSection.append(urlRow, qrImg, warn)
  body.append(activeSection)

  // ── Error ─────────────────────────────────────────────────────────────────
  const errorEl = document.createElement('p')
  errorEl.className = 'phone-error hidden'
  body.append(errorEl)

  // ── Desc ──────────────────────────────────────────────────────────────────
  const desc = document.createElement('p')
  desc.className = 'phone-desc'
  desc.textContent = 'Tu Mac actúa como servidor. El móvil se conecta directamente por WiFi sin instalar ninguna app.'
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
    toggleText.textContent = s.running ? 'Servidor activo' : 'Activar servidor WiFi'
    if (s.running && s.url) {
      urlCode.textContent = s.url
      try {
        qrImg.src = await QRCode.toDataURL(s.url, { width: 220, margin: 2, color: { dark: '#e2e8f8', light: '#0e0e1c' } })
      } catch { /* ignore */ }
      activeSection.classList.remove('hidden')
    } else {
      activeSection.classList.add('hidden')
    }
  }

  const startServer = async (): Promise<void> => {
    const port = parseInt(portInput.value) || 7879
    localStorage.setItem(PORT_KEY, String(port))
    const savedToken = localStorage.getItem(TOKEN_KEY) ?? undefined
    const s = await invoke<RemoteStatus>('remote_start', { port, token: savedToken })
    if (s.token) localStorage.setItem(TOKEN_KEY, s.token)
    await render(s)
  }

  const stopServer = async (): Promise<void> => {
    await invoke('remote_stop')
    await render({ running: false })
  }

  // ── Mount: sync state with daemon, retry until connected ──────────────────
  const RETRY_DELAYS = [300, 600, 1200, 2000, 3000]
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let userInteracted = false

  const cancelRetries = (): void => {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
  }

  // On panel open: the server should already be running (auto-started in main.ts).
  // Retry until the daemon is reachable, then start the server if it isn't already up.
  const init = async (attempt = 0): Promise<void> => {
    if (userInteracted) return
    toggleText.textContent = 'Comprobando…'
    toggleInput.disabled = true
    try {
      const s = await invoke<RemoteStatus>('remote_status')
      if (userInteracted) return
      toggleInput.disabled = false
      if (s.running) {
        await render(s)
      } else {
        await startServer()
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
    toggleText.textContent = toggleInput.checked ? 'Activando…' : 'Desactivando…'
    try {
      if (toggleInput.checked) {
        await startServer()
      } else {
        await stopServer()
      }
    } catch (e) {
      showError(`Error: ${String(e)}`)
      toggleInput.checked = !toggleInput.checked
      toggleText.textContent = toggleInput.checked ? 'Servidor activo' : 'Activar servidor WiFi'
    } finally {
      toggleInput.disabled = false
    }
  }

  void init()

  return { element: root }
}
