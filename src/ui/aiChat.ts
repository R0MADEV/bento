import { icon } from './icons'
import { AI_PROVIDERS, providerById } from '../core/ai/providers'
import {
  loadConfig, saveConfig, buildChatBody,
  type AiConfig, type ChatMessage,
} from '../core/ai/config'
import { getAiKey, setAiKey, vaultStatus, type VaultStatus } from './aiKeys'
import { splitLines, deltaFromLine, isDoneLine } from '../core/ai/sseStream'
import { renderMarkdown } from '../core/notes/renderMarkdown'
import { t as i18nT } from '../i18n'
import { expandInput, SLASH_COMMANDS } from '../core/ai/prompts'
import { showContextMenu } from './contextMenu'
import { AI_ASK_EVENT, type AiAskDetail, type AiQueryRunner, type AiTool } from './askAi'
import type { MemoryRepository } from '../ports/MemoryRepository'
import { getActiveProjectPath } from './activeProject'
import { buildMemoryContext, selectMemoryForPrompt } from '../core/memory/aiContext'

// Messages as the API expects them (includes tool_calls and tool responses).
interface ApiToolCall { id: string; function: { name: string; arguments: string } }
interface ApiMessage { role: string; content?: string | null; tool_calls?: ApiToolCall[]; tool_call_id?: string }

// Floating AI chat widget (OpenAI-compatible endpoint). Button in the
// corner; opening it shows a modal with the thread, provider/model selector and settings.
export function createAiChat(memoryRepo: MemoryRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ai-chat'

  const toggle = document.createElement('button')
  toggle.className = 'ai-fab'
  toggle.title = i18nT('common.aiAssistantI')
  toggle.innerHTML = icon('chat')
  root.appendChild(toggle)

  const modal = document.createElement('div')
  modal.className = 'ai-modal hidden'
  root.appendChild(modal)

  // ── Header: provider + model + settings + close ──────────────────────────
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
  modelSelect.placeholder = i18nT('common.model')
  const modelList = document.createElement('datalist')
  modelList.id = 'ai-model-list'

  const expandBtn = document.createElement('button')
  expandBtn.className = 'ai-icon-btn'
  expandBtn.title = i18nT('common.expandShrink')
  expandBtn.innerHTML = icon('expand')

  const settingsBtn = document.createElement('button')
  settingsBtn.className = 'ai-icon-btn'
  settingsBtn.title = i18nT('common.settings2')
  settingsBtn.innerHTML = icon('settings')

  const closeBtn = document.createElement('button')
  closeBtn.className = 'ai-icon-btn'
  closeBtn.title = i18nT('common.close')
  closeBtn.innerHTML = icon('x')

  header.append(providerSelect, modelSelect, modelList, expandBtn, settingsBtn, closeBtn)

  // ── Settings: base URL + API key ─────────────────────────────────────────
  const settings = document.createElement('div')
  settings.className = 'ai-settings hidden'
  const baseUrlInput = document.createElement('input')
  baseUrlInput.className = 'ai-field'
  baseUrlInput.placeholder = i18nT('common.aiBaseUrlPlaceholder')
  const keyInput = document.createElement('input')
  keyInput.className = 'ai-field'
  keyInput.type = 'password'
  keyInput.placeholder = i18nT('common.apiKey')
  keyInput.autocomplete = 'off'
  const systemInput = document.createElement('textarea')
  systemInput.className = 'ai-field ai-system'
  systemInput.rows = 2
  systemInput.placeholder = i18nT('common.aiSystemPlaceholder')
  const vaultNotice = document.createElement('div')
  vaultNotice.className = 'ai-vault-notice hidden'
  settings.append(
    labeled('Prompt de sistema', systemInput),
    labeled('Base URL', baseUrlInput),
    labeled('API key', keyInput),
    vaultNotice,
  )

  // ── Message thread ───────────────────────────────────────────────────────
  const thread = document.createElement('div')
  thread.className = 'ai-thread'

  // ── Input bar ────────────────────────────────────────────────────────────
  const inputRow = document.createElement('div')
  inputRow.className = 'ai-input-row'
  const templatesBtn = document.createElement('button')
  templatesBtn.className = 'ai-icon-btn ai-templates'
  templatesBtn.title = i18nT('common.templatesCommands')
  templatesBtn.textContent = '/'
  const input = document.createElement('textarea')
  input.className = 'ai-input'
  input.rows = 1
  input.placeholder = i18nT('common.aiMessagePlaceholder')
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

  // ── State ────────────────────────────────────────────────────────────────
  let cfg: AiConfig = loadConfig()
  saveConfig(cfg) // rewrites the config without secrets (clears plaintext keys from the old schema)
  const messages: ChatMessage[] = []
  let streaming = false

  const applyConfigToUi = (): void => {
    providerSelect.value = cfg.providerId
    modelSelect.value = cfg.model
    baseUrlInput.value = cfg.baseUrl
    systemInput.value = cfg.systemPrompt
    keyInput.placeholder = i18nT('common.aiKeyPlaceholder', {
      provider: providerById(cfg.providerId)?.label ?? i18nT('common.provider'),
    })
    refreshModelSuggestions()
  }

  // Shows the Vault status and adjusts the key field accordingly.
  const showVaultNotice = (status: VaultStatus): void => {
    const msg = status === 'absent'
      ? i18nT('common.createVaultForAiKey')
      : status === 'locked'
        ? i18nT('common.unlockVaultForAiKey')
        : ''
    vaultNotice.textContent = msg
    vaultNotice.classList.toggle('hidden', status === 'unlocked')
    keyInput.disabled = status !== 'unlocked'
  }

  // The key lives in the Vault, not in the config: it's loaded separately (async) and only if
  // the Vault is unlocked.
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
      // When switching provider, adopt its base URL and first model by default.
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
  // Saves the key in the Vault under the active provider (each provider has its own).
  keyInput.addEventListener('change', async () => {
    const ok = await setAiKey(cfg.providerId, keyInput.value.trim(), cfg.baseUrl)
    if (!ok) showVaultNotice(await vaultStatus())
  })

  settingsBtn.addEventListener('click', () => settings.classList.toggle('hidden'))

  // Width expandable with a click; remembered between sessions.
  const WIDE_KEY = 'bento.ai.wide'
  if (localStorage.getItem(WIDE_KEY) === '1') modal.classList.add('wide')
  expandBtn.addEventListener('click', () => {
    const wide = modal.classList.toggle('wide')
    localStorage.setItem(WIDE_KEY, wide ? '1' : '0')
  })

  // Query runner and tools provided by the panel that opened the chat.
  let runner: AiQueryRunner | undefined
  let tools: AiTool[] | undefined

  // If there's a runner, add "▶ Ejecutar" to each of the assistant's code blocks.
  const decorateRunButtons = (): void => {
    if (!runner) return
    thread.querySelectorAll<HTMLElement>('.ai-msg-assistant pre').forEach(pre => {
      const btn = document.createElement('button')
      btn.className = 'ai-run-btn'
      btn.textContent = i18nT('common.run2')
      btn.addEventListener('click', async () => {
        const code = pre.querySelector('code')?.textContent?.trim()
        if (!code || !runner) return
        btn.disabled = true
        btn.textContent = i18nT('common.running')
        const result = document.createElement('div')
        result.className = 'ai-run-result'
        result.append(await runner(code))
        pre.after(result)
        btn.remove()
      })
      pre.appendChild(btn)
    })
  }

  // ── Thread render ────────────────────────────────────────────────────────
  const renderThread = (): void => {
    thread.innerHTML = ''
    messages.forEach(m => {
      const row = document.createElement('div')
      row.className = `ai-msg ai-msg-${m.role}`
      // The assistant is rendered as Markdown (renderMarkdown escapes the HTML first,
      // so it's safe). The user's message goes as plain text.
      if (m.role === 'assistant') row.innerHTML = renderMarkdown(m.content)
      else row.textContent = m.content
      thread.appendChild(row)
    })
    decorateRunButtons()
    thread.scrollTop = thread.scrollHeight
  }

  // ── Streaming send ───────────────────────────────────────────────────────
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
    // Slash commands (/traducir, /explica…) expand into a full prompt.
    messages.push({ role: 'user', content: expandInput(text) })
    const assistant: ChatMessage = { role: 'assistant', content: '' }
    messages.push(assistant)
    renderThread()

    // History without the assistant placeholder; the project memory is sent as
    // private system context and is never added to the visible conversation.
    const history = messages.slice(0, -1)
    const projectPath = getActiveProjectPath()
    const memory = projectPath
      ? await memoryRepo.list(projectPath).then(entries => buildMemoryContext(selectMemoryForPrompt(entries, text), projectPath)).catch(() => null)
      : null
    const systemMessages: ChatMessage[] = [
      ...(cfg.systemPrompt ? [{ role: 'system' as const, content: cfg.systemPrompt }] : []),
      ...(memory ? [{ role: 'system' as const, content: memory }] : []),
    ]
    const apiMessages: ChatMessage[] = [...systemMessages, ...history]

    streaming = true
    root.classList.add('busy')
    try {
      if (tools?.length) await runWithTools(apiMessages, assistant, apiKey)
      else await streamReply(apiMessages, assistant, apiKey)
    } catch (e) {
      assistant.content = `⚠️ ${e instanceof Error ? e.message : 'Fallo de red'}`
      renderThread()
    } finally {
      streaming = false
      root.classList.remove('busy')
    }
  }

  const chatUrl = (): string => `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
  const authHeaders = (apiKey: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` })

  // Normal streaming reply (without tools).
  async function streamReply(apiMessages: ChatMessage[], assistant: ChatMessage, apiKey: string): Promise<void> {
    const res = await fetch(chatUrl(), { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(buildChatBody(apiMessages, cfg.model)) })
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
  }

  // With tools: non-streaming loop. The AI can request schema data
  // (get_columns…) and we execute it and return it to the AI until it
  // produces the final reply.
  async function runWithTools(apiMessages: ChatMessage[], assistant: ChatMessage, apiKey: string): Promise<void> {
    const byName = new Map(tools!.map(t => [t.name, t]))
    const msgs: ApiMessage[] = [...apiMessages]
    for (let i = 0; i < 6; i++) {
      const res = await fetch(chatUrl(), {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ model: cfg.model, messages: msgs, tools: tools!.map(t => t.schema), tool_choice: 'auto' }),
      })
      if (!res.ok) { assistant.content = `⚠️ Error ${res.status}: ${(await res.text()).slice(0, 300)}`; renderThread(); return }
      const data = await res.json() as { choices?: Array<{ message?: ApiMessage }> }
      const m = data.choices?.[0]?.message
      if (!m) { assistant.content = i18nT('common.emptyModelResponse'); renderThread(); return }
      if (m.tool_calls?.length) {
        msgs.push(m)
        assistant.content = '🔧 Consultando el esquema…'
        renderThread()
        for (const tc of m.tool_calls) {
          const tool = byName.get(tc.function?.name)
          let result = 'herramienta desconocida'
          if (tool) {
            try { result = await tool.run(JSON.parse(tc.function.arguments || '{}')) }
            catch (err) { result = `error: ${err instanceof Error ? err.message : String(err)}` }
          }
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
        }
        continue
      }
      assistant.content = m.content ?? ''
      renderThread()
      return
    }
    assistant.content += `\n\n${i18nT('common.tooManyToolCalls')}`
    renderThread()
  }

  sendBtn.addEventListener('click', send)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  // Auto-grow the textarea up to a maximum (the CSS caps it with max-height).
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  })

  // ── Open / close ─────────────────────────────────────────────────────────
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

  // Context from other panels: opens the chat with the text preloaded (or sends it).
  window.addEventListener(AI_ASK_EVENT, e => {
    const detail = (e as CustomEvent<AiAskDetail>).detail
    runner = detail.runner // enables/clears the Run button depending on the origin
    tools = detail.tools   // enables/clears function-calling depending on the origin
    open()
    input.value = detail.text
    input.dispatchEvent(new Event('input')) // recalculates the textarea height
    input.focus()
    if (detail.autoSend) send()
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
