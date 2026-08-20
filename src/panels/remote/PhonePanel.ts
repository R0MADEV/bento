import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/icons'
import QRCode from 'qrcode'

interface RemoteStatus {
  running: boolean
  url?: string
  token?: string
  addr?: string
}

const PORT_KEY = 'bento.remote.port'

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

  // ── Active section (shown only when running) ───────────────────────────────
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

  // ── Error message ─────────────────────────────────────────────────────────
  const errorEl = document.createElement('p')
  errorEl.className = 'phone-error hidden'
  body.append(errorEl)

  // ── Desc (always visible) ─────────────────────────────────────────────────
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

  toggleInput.onchange = async () => {
    clearError()
    const port = parseInt(portInput.value) || 7879
    localStorage.setItem(PORT_KEY, String(port))
    toggleInput.disabled = true
    try {
      if (toggleInput.checked) {
        const s = await invoke<RemoteStatus>('remote_start', { port })
        await render(s)
      } else {
        await invoke('remote_stop')
        await render({ running: false })
      }
    } catch (e) {
      showError(`Error: ${String(e)}`)
      // Revert checkbox to reflect actual state
      toggleInput.checked = !toggleInput.checked
    } finally {
      toggleInput.disabled = false
    }
  }

  // Load current status on mount
  invoke<RemoteStatus>('remote_status').then(render).catch(() => {})

  return { element: root }
}
