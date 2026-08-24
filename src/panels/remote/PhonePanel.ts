import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { icon } from '../../ui/icons'
import QRCode from 'qrcode'

const DEPLOY_SIGNALING_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/R0MADEV/bento/tree/main/workers/signaling'

interface RemoteStatus {
  running: boolean
  url?: string
  token?: string
  addr?: string
}

const PORT_KEY       = 'bento.remote.port'
const TOKEN_KEY      = 'bento.remote.token'
const TAILSCALE_KEY  = 'bento.remote.tailscale'
const SIGNALING_KEY  = 'bento.remote.webrtcSignalingBase'

const generatePairingCode = (): string => String(Math.floor(100000 + Math.random() * 900000))

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
  toggleText.textContent = 'Activar servidor WiFi'
  toggleLabel.append(toggleInput, toggleText)

  // Tailscale toggle (hidden until tailscale_detect confirms it's available)
  const tsLabel = document.createElement('label')
  tsLabel.className = 'phone-toggle-row hidden'
  const tsToggle = document.createElement('input')
  tsToggle.type = 'checkbox'
  // Opt-out: checked unless user explicitly set to 'false'
  tsToggle.checked = localStorage.getItem(TAILSCALE_KEY) !== 'false'
  const tsText = document.createElement('span')
  tsText.textContent = 'Usar Tailscale (fuera de casa)'
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
  portLabel.textContent = 'Puerto'
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

  // ── WebRTC pairing (no Tailscale, works from any network) ───────────────────
  const webrtcSection = document.createElement('div')
  webrtcSection.className = 'phone-active'

  const webrtcTitle = document.createElement('p')
  webrtcTitle.className = 'phone-desc'
  webrtcTitle.textContent = 'Emparejar sin Tailscale (WebRTC) — funciona desde cualquier red.'

  const signalingRow = document.createElement('div')
  signalingRow.className = 'phone-port-row'
  const signalingLabel = document.createElement('span')
  signalingLabel.textContent = 'URL del Worker'
  const signalingInput = document.createElement('input')
  signalingInput.type = 'text'
  signalingInput.className = 'phone-port-input'
  signalingInput.style.width = '220px'
  signalingInput.placeholder = 'https://tu-worker.workers.dev'
  signalingInput.value = localStorage.getItem(SIGNALING_KEY) ?? ''
  signalingInput.onchange = () => localStorage.setItem(SIGNALING_KEY, signalingInput.value.trim())
  signalingRow.append(signalingLabel, signalingInput)

  const deployHint = document.createElement('a')
  deployHint.className = 'phone-hint-link'
  deployHint.textContent = '¿No tenés servidor propio? Desplegalo gratis (1 clic, sin terminal)'
  deployHint.addEventListener('click', () => openUrl(DEPLOY_SIGNALING_URL).catch(() => {}))

  const pairBtn = document.createElement('button')
  pairBtn.className = 'phone-copy-btn'
  pairBtn.textContent = 'Generar código'

  const pairStatus = document.createElement('p')
  pairStatus.className = 'phone-warn'

  const pairUrlRow = document.createElement('div')
  pairUrlRow.className = 'phone-url-row hidden'
  const pairUrlCode = document.createElement('code')
  pairUrlCode.className = 'phone-url'
  const pairCopyBtn = document.createElement('button')
  pairCopyBtn.className = 'phone-copy-btn'
  pairCopyBtn.innerHTML = icon('copy') + ' Copiar'
  pairCopyBtn.onclick = () => {
    const text = pairUrlCode.textContent
    if (text) void navigator.clipboard.writeText(text)
  }
  pairUrlRow.append(pairUrlCode, pairCopyBtn)

  const pairQrImg = document.createElement('img')
  pairQrImg.className = 'phone-qr hidden'
  pairQrImg.alt = 'QR de emparejamiento WebRTC'

  webrtcSection.append(webrtcTitle, signalingRow, deployHint, pairBtn, pairStatus, pairUrlRow, pairQrImg)
  body.append(webrtcSection)

  let currentToken: string | undefined
  // Guards against a status event from a previous (now-abandoned) pairing
  // attempt updating the UI for the one currently shown.
  let currentPairingCode: string | undefined

  const WEBRTC_STATE_LABELS: Record<string, string> = {
    connecting: 'Conectando (P2P)…',
    connected: 'Conectado ✓',
    disconnected: 'Desconectado.',
    failed: 'Falló la conexión P2P — generá un código nuevo.',
    closed: 'Conexión cerrada.',
  }
  void listen<{ code: string; state: string }>('webrtc-status', ({ payload }) => {
    if (payload.code !== currentPairingCode) return
    const label = WEBRTC_STATE_LABELS[payload.state]
    if (label) pairStatus.textContent = label
  })

  const generatePairing = async (): Promise<void> => {
    const signalingBase = signalingInput.value.trim().replace(/\/$/, '')
    if (!signalingBase) { pairStatus.textContent = 'Pegá la URL de tu Worker de señalización primero.'; return }

    pairBtn.disabled = true
    pairStatus.textContent = 'Generando código…'
    try {
      if (!currentToken) {
        pairStatus.textContent = 'Activando servidor WiFi…'
        await startServer()
      }
      if (!currentToken) throw new Error('no se pudo activar el servidor WiFi')
      const code = generatePairingCode()
      currentPairingCode = code
      await invoke('webrtc_connect', { code, signalingBase })
      const pairUrl = `${signalingBase}/pair?code=${code}&token=${encodeURIComponent(currentToken)}`
      pairUrlCode.textContent = pairUrl
      pairUrlRow.classList.remove('hidden')
      pairQrImg.src = await QRCode.toDataURL(pairUrl, { width: 220, margin: 2, color: { dark: '#e2e8f8', light: '#0e0e1c' } })
      pairQrImg.classList.remove('hidden')
      pairStatus.textContent = 'Esperando a que el móvil escanee el código o abra el enlace…'
    } catch (e) {
      pairStatus.textContent = `Error: ${String(e)}`
    } finally {
      pairBtn.disabled = false
    }
  }
  pairBtn.onclick = () => void generatePairing()

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
      warn.textContent = tsToggle.checked
        ? 'Accesible vía Tailscale desde cualquier red.'
        : 'Solo en tu red WiFi local — nunca exponer a internet.'
      activeSection.classList.remove('hidden')
    } else {
      activeSection.classList.add('hidden')
    }
    currentToken = s.token
    webrtcSection.classList.toggle('hidden', !s.running)
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
    toggleText.textContent = 'Comprobando…'
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
