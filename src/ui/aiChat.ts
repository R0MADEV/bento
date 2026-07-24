import { icon } from './icons'
import { AI_PROVIDERS, providerById } from '../core/ai/providers'
import {
  loadConfig, saveConfig, buildChatBody,
  type AiConfig, type ChatMessage,
} from '../core/ai/config'
import { getAiKey, setAiKey, vaultStatus, type VaultStatus } from './aiKeys'
import { splitLines, deltaFromLine, isDoneLine } from '../core/ai/sseStream'
import { renderMarkdown } from '../core/notes/renderMarkdown'
import { expandInput, SLASH_COMMANDS } from '../core/ai/prompts'
import { showContextMenu } from './contextMenu'
import { AI_ASK_EVENT, type AiAskDetail } from './askAi'

// Widget flotante de chat con IA (endpoint compatible OpenAI). Botón en la
// esquina; al abrir, un modal con el hilo, selector de proveedor/modelo y ajustes.
export function createAiChat(): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ai-chat'

  const toggle = document.createElement('button')
  toggle.className = 'ai-fab'
  toggle.title = 'Asistente IA (⌘I)'
  toggle.innerHTML = icon('chat')
  root.appendChild(toggle)

  const modal = document.createElement('div')
  modal.className = 'ai-modal hidden'
  root.appendChild(modal)

  // ── Cabecera: proveedor + modelo + ajustes + cerrar ──────────────────────
  const header = document.createElement('div')
  header.className = 'ai-header'

  const providerSelect = document.createElement('select')
  providerSelect.className = 'ai-select'
  AI_PROVIDERS.forEach(p => {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    providerSelect.appendChild(opt)
  })

  const modelSelect = document.createElement('input')
  modelSelect.className = 'ai-model'
  modelSelect.setAttribute('list', 'ai-model-list')
  modelSelect.placeholder = 'modelo'
  const modelList = document.createElement('datalist')
  modelList.id = 'ai-model-list'

  const expandBtn = document.createElement('button')
  expandBtn.className = 'ai-icon-btn'
  expandBtn.title = 'Ensanchar / estrechar'
  expandBtn.innerHTML = icon('expand')

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'ai-icon-btn'
  settingsBtn.title = 'Ajustes'
  settingsBtn.innerHTML = icon('settings')

  const closeBtn = document.createElement('button')
  closeBtn.className = 'ai-icon-btn'
  closeBtn.title = 'Cerrar'
  closeBtn.innerHTML = icon('x')

  header.append(providerSelect, modelSelect, modelList, expandBtn, settingsBtn, closeBtn)

  // ── Ajustes: base URL + API key ──────────────────────────────────────────
  const settings = document.createElement('div')
  settings.className = 'ai-settings hidden'
  const baseUrlInput = document.createElement('input')
  baseUrlInput.className = 'ai-field'
  baseUrlInput.placeholder = 'https://api.openai.com/v1'
  const keyInput = document.createElement('input')
  keyInput.className = 'ai-field'
  keyInput.type = 'password'
  keyInput.placeholder = 'API key'
  keyInput.autocomplete = 'off'
  const systemInput = document.createElement('textarea')
  systemInput.className = 'ai-field ai-system'
  systemInput.rows = 2
  systemInput.placeholder = 'Ej: Eres un asistente conciso que responde en español.'
  const vaultNotice = document.createElement('div')
  vaultNotice.className = 'ai-vault-notice hidden'
  settings.append(
    labeled('Prompt de sistema', systemInput),
    labeled('Base URL', baseUrlInput),
    labeled('API key', keyInput),
    vaultNotice,
  )

  // ── Hilo de mensajes ─────────────────────────────────────────────────────
  const thread = document.createElement('div')
  thread.className = 'ai-thread'

  // ── Barra de entrada ─────────────────────────────────────────────────────
  const inputRow = document.createElement('div')
  inputRow.className = 'ai-input-row'
  const templatesBtn = document.createElement('button')
  templatesBtn.className = 'ai-icon-btn ai-templates'
  templatesBtn.title = 'Plantillas (/comandos)'
  templatesBtn.textContent = '/'
  const input = document.createElement('textarea')
  input.className = 'ai-input'
  input.rows = 1
  input.placeholder = 'Escribe un mensaje…  (Enter envía, Shift+Enter salto)'
  const sendBtn = document.createElement('button')
  sendBtn.className = 'ai-send'
  sendBtn.innerHTML = icon('send')
  inputRow.append(templatesBtn, input, sendBtn)

  templatesBtn.addEventListener('click', () => {
    const rect = templatesBtn.getBoundingClientRect()
    showContextMenu(rect.left, rect.top, SLASH_COMMANDS.map(c => ({
      label: `/${c.name} — ${c.label}`,
      onClick: () => { input.value = `/${c.name} `; input.focus() },
    })))
  })

  modal.append(header, settings, thread, inputRow)

  // ── Estado ───────────────────────────────────────────────────────────────
  let cfg: AiConfig = loadConfig()
  saveConfig(cfg) // reescribe la config sin secretos (limpia keys en claro del esquema viejo)
  const messages: ChatMessage[] = []
  let streaming = false

  const applyConfigToUi = (): void => {
    providerSelect.value = cfg.providerId
    modelSelect.value = cfg.model
    baseUrlInput.value = cfg.baseUrl
    systemInput.value = cfg.systemPrompt
    keyInput.placeholder = `API key de ${providerById(cfg.providerId)?.label ?? 'proveedor'}`
    refreshModelSuggestions()
  }

  // Muestra el estado del Vault y ajusta el campo de la key en consecuencia.
  const showVaultNotice = (status: VaultStatus): void => {
    const msg = status === 'absent'
      ? '🔒 Crea el Vault (panel Vault) para guardar tu API key de forma segura.'
      : status === 'locked'
        ? '🔒 Desbloquea el Vault (panel Vault) para ver o guardar tu API key.'
        : ''
    vaultNotice.textContent = msg
    vaultNotice.classList.toggle('hidden', status === 'unlocked')
    keyInput.disabled = status !== 'unlocked'
  }

  // La key vive en el Vault, no en la config: se carga aparte (async) y solo si
  // el Vault está desbloqueado.
  const loadKeyField = async (): Promise<void> => {
    const status = await vaultStatus()
    showVaultNotice(status)
    keyInput.value = status === 'unlocked' ? await getAiKey(cfg.providerId) : ''
  }

  function refreshModelSuggestions(): void {
    const provider = providerById(cfg.providerId)
    modelList.innerHTML = ''
    ;(provider?.models ?? []).forEach(m => {
      const opt = document.createElement('option')
      opt.value = m
      modelList.appendChild(opt)
    })
  }

  const persist = (): void => saveConfig(cfg)

  providerSelect.addEventListener('change', () => {
    const provider = providerById(providerSelect.value)
    cfg = {
      ...cfg,
      providerId: providerSelect.value,
      // Al cambiar de proveedor, adopta su base URL y primer modelo por defecto.
      baseUrl: provider && provider.id !== 'custom' ? provider.baseUrl : cfg.baseUrl,
      model: provider?.models[0] ?? cfg.model,
    }
    applyConfigToUi()
    loadKeyField()
    persist()
  })
  modelSelect.addEventListener('change', () => { cfg = { ...cfg, model: modelSelect.value.trim() }; persist() })
  baseUrlInput.addEventListener('change', () => { cfg = { ...cfg, baseUrl: baseUrlInput.value.trim() }; persist() })
  systemInput.addEventListener('change', () => { cfg = { ...cfg, systemPrompt: systemInput.value.trim() }; persist() })
  // Guarda la key en el Vault bajo el proveedor activo (cada uno la suya).
  keyInput.addEventListener('change', async () => {
    const ok = await setAiKey(cfg.providerId, keyInput.value.trim(), cfg.baseUrl)
    if (!ok) showVaultNotice(await vaultStatus())
  })

  settingsBtn.addEventListener('click', () => settings.classList.toggle('hidden'))

  // Ancho ampliable con un click; se recuerda entre sesiones.
  const WIDE_KEY = 'bento.ai.wide'
  if (localStorage.getItem(WIDE_KEY) === '1') modal.classList.add('wide')
  expandBtn.addEventListener('click', () => {
    const wide = modal.classList.toggle('wide')
    localStorage.setItem(WIDE_KEY, wide ? '1' : '0')
  })

  // ── Render del hilo ──────────────────────────────────────────────────────
  const renderThread = (): void => {
    thread.innerHTML = ''
    messages.forEach(m => {
      const row = document.createElement('div')
      row.className = `ai-msg ai-msg-${m.role}`
      // El asistente se pinta como Markdown (renderMarkdown escapa el HTML antes,
      // así que es seguro). El mensaje del usuario va como texto plano.
      if (m.role === 'assistant') row.innerHTML = renderMarkdown(m.content)
      else row.textContent = m.content
      thread.appendChild(row)
    })
    thread.scrollTop = thread.scrollHeight
  }

  // ── Envío con streaming ──────────────────────────────────────────────────
  async function send(): Promise<void> {
    const text = input.value.trim()
    if (!text || streaming) return
    const status = await vaultStatus()
    if (status !== 'unlocked') {
      settings.classList.remove('hidden')
      showVaultNotice(status)
      return
    }
    const apiKey = await getAiKey(cfg.providerId)
    if (!apiKey || !cfg.baseUrl) {
      settings.classList.remove('hidden')
      return
    }

    input.value = ''
    input.style.height = 'auto'
    // Los slash commands (/traducir, /explica…) se expanden a un prompt completo.
    messages.push({ role: 'user', content: expandInput(text) })
    const assistant: ChatMessage = { role: 'assistant', content: '' }
    messages.push(assistant)
    renderThread()

    // Historial sin el placeholder del asistente; el prompt de sistema va delante.
    const history = messages.slice(0, -1)
    const apiMessages: ChatMessage[] = cfg.systemPrompt
      ? [{ role: 'system', content: cfg.systemPrompt }, ...history]
      : history

    streaming = true
    root.classList.add('busy')
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildChatBody(apiMessages, cfg.model)),
      })
      if (!res.ok || !res.body) {
        assistant.content = `⚠️ Error ${res.status}: ${(await res.text()).slice(0, 300)}`
        renderThread()
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let done = false
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const split = splitLines(buffer)
        buffer = split.rest
        for (const line of split.lines) {
          if (isDoneLine(line)) { done = true; break }
          const delta = deltaFromLine(line)
          if (delta) { assistant.content += delta; renderThread() }
        }
      }
    } catch (e) {
      assistant.content = `⚠️ ${e instanceof Error ? e.message : 'Fallo de red'}`
      renderThread()
    } finally {
      streaming = false
      root.classList.remove('busy')
    }
  }

  sendBtn.addEventListener('click', send)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  // Auto-crecer el textarea hasta un máximo (la CSS limita con max-height).
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  })

  // ── Apertura / cierre ────────────────────────────────────────────────────
  const open = (): void => {
    modal.classList.remove('hidden')
    root.classList.add('open')
    applyConfigToUi()
    loadKeyField()
    input.focus()
  }
  const close = (): void => { modal.classList.add('hidden'); root.classList.remove('open') }
  const toggleOpen = (): void => (modal.classList.contains('hidden') ? open() : close())

  toggle.addEventListener('click', toggleOpen)
  closeBtn.addEventListener('click', close)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); toggleOpen() }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close()
  })

  // Contexto desde otros paneles: abre el chat con el texto precargado (o lo envía).
  window.addEventListener(AI_ASK_EVENT, e => {
    const { text, autoSend } = (e as CustomEvent<AiAskDetail>).detail
    open()
    input.value = text
    input.dispatchEvent(new Event('input')) // recalcula la altura del textarea
    input.focus()
    if (autoSend) send()
  })

  return root
}

function labeled(text: string, field: HTMLElement): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'ai-field-row'
  const span = document.createElement('span')
  span.textContent = text
  wrap.append(span, field)
  return wrap
}
