import { invoke } from '@tauri-apps/api/core'
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
import { getActiveProjectPath, setActiveProjectPath } from './activeProject'
import { buildMemoryContext, selectMemoryForPrompt } from '../core/memory/aiContext'
import { startAgent } from '../core/ai/agentClient'
import { emptyChatHistory, GLOBAL_CHAT_CONVERSATION, parseChatHistory, serializeChatHistory } from '../core/ai/chatHistory'
import { getUiZoom, toLayoutPixels } from './zoom'

const AI_POSITION_KEY = 'bento.ai.position.v2'
const MAX_HISTORY = 200

// Messages as the API expects them (includes tool_calls and tool responses).
interface ApiToolCall { id: string; function: { name: string; arguments: string } }
interface ApiMessage { role: string; content?: string | null; tool_calls?: ApiToolCall[]; tool_call_id?: string }
interface ReviewBranchContextResult { path: string; commit: string; latestCommit: string; managed: boolean; stale: boolean }

// Floating AI chat widget (OpenAI-compatible endpoint). Button in the
// corner; opening it shows a modal with the thread, provider/model selector and settings.
export function createAiChat(memoryRepo: MemoryRepository): HTMLElement {
  const root = document.createElement('div')
  root.className = 'ai-chat'
  let dragX = 0
  let dragY = 0
  let fabPosition = { x: 0, y: 0 }
  try {
    const saved = JSON.parse(localStorage.getItem(AI_POSITION_KEY) ?? '{}') as { x?: number; y?: number }
    dragX = Number.isFinite(saved.x) ? saved.x! : 0
    dragY = Number.isFinite(saved.y) ? saved.y! : 0
  } catch { /* use the default position */ }
  root.style.setProperty('--ai-drag-x', `${dragX}px`)
  root.style.setProperty('--ai-drag-y', `${dragY}px`)

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

  const historySelect = document.createElement('select')
  historySelect.className = 'ai-select ai-history-select'
  historySelect.dataset.testid = 'ai-history-select'
  historySelect.title = i18nT('common.chatHistory')

  const historyRefreshBtn = document.createElement('button')
  historyRefreshBtn.className = 'ai-icon-btn hidden'
  historyRefreshBtn.dataset.testid = 'ai-history-refresh'
  historyRefreshBtn.title = i18nT('common.updateReviewedBranch')
  historyRefreshBtn.innerHTML = icon('refresh')

  const providerSelect = document.createElement('select')
  providerSelect.className = 'ai-select'
  AI_PROVIDERS.forEach(p => {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    providerSelect.appendChild(opt)
  })
  const agentSelect = document.createElement('select')
  agentSelect.className = 'ai-select ai-agent-select hidden'
  ;[['claude', 'Claude Code'], ['opencode', 'OpenCode'], ['codex', 'Codex'], ['custom', 'Custom CLI']].forEach(([value, label]) => {
    agentSelect.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }))
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

  const clearBtn = document.createElement('button')
  clearBtn.className = 'ai-icon-btn'
  clearBtn.dataset.testid = 'ai-history-delete'
  clearBtn.title = i18nT('common.clearCurrentConversation')
  clearBtn.innerHTML = icon('trash')

  const closeBtn = document.createElement('button')
  closeBtn.className = 'ai-icon-btn'
  closeBtn.title = i18nT('common.close')
  closeBtn.innerHTML = icon('x')

  header.append(historySelect, historyRefreshBtn, providerSelect, agentSelect, modelSelect, modelList, expandBtn, settingsBtn, clearBtn, closeBtn)

  const clampPosition = (): void => {
    const zoom = getUiZoom()
    const viewportWidth = window.innerWidth / zoom
    const viewportHeight = window.innerHeight / zoom
    const width = modal.classList.contains('hidden') ? (toggle.offsetWidth || 44) : (modal.offsetWidth || 460)
    const height = modal.classList.contains('hidden') ? (toggle.offsetHeight || 44) : (modal.offsetHeight || 320)
    const minX = -16
    const maxX = Math.max(minX, viewportWidth - width - 16)
    const minY = Math.min(16, height + 32 - viewportHeight)
    const maxY = Math.max(minY, viewportHeight - height - 32)
    dragX = Math.max(minX, Math.min(maxX, dragX))
    dragY = Math.max(minY, Math.min(maxY, dragY))
    root.style.setProperty('--ai-drag-x', `${dragX}px`)
    root.style.setProperty('--ai-drag-y', `${dragY}px`)
  }
  window.addEventListener('resize', clampPosition)
  window.addEventListener('bento:zoom-change', clampPosition)

  const savePosition = (): void => {
    localStorage.setItem(AI_POSITION_KEY, JSON.stringify({ x: dragX, y: dragY }))
  }
  const draggable = (handle: HTMLElement): void => {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      if (handle === header && (e.target as Element).closest('button, input, select, textarea')) return
      const startX = e.clientX
      const startY = e.clientY
      const initialX = dragX
      const initialY = dragY
      let moved = false
      const onMove = (event: PointerEvent): void => {
        const zoom = getUiZoom()
        const dx = toLayoutPixels(event.clientX - startX, zoom)
        const dy = toLayoutPixels(event.clientY - startY, zoom)
        moved = moved || Math.abs(dx) > 3 || Math.abs(dy) > 3
        if (!moved) return
        dragX = initialX + dx
        dragY = initialY + dy
        clampPosition()
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (moved) savePosition()
        root.dataset.dragged = moved ? 'true' : 'false'
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    })
  }
  draggable(toggle)
  draggable(header)
  clampPosition()

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
  const agentExecutableInput = document.createElement('input')
  agentExecutableInput.className = 'ai-field ai-agent-config hidden'
  agentExecutableInput.placeholder = 'Custom executable'
  const agentArgsInput = document.createElement('input')
  agentArgsInput.className = 'ai-field ai-agent-config hidden'
  agentArgsInput.placeholder = 'Arguments (space-separated)'
  const vaultNotice = document.createElement('div')
  vaultNotice.className = 'ai-vault-notice hidden'
  settings.append(
    labeled('Prompt de sistema', systemInput),
    labeled('Base URL', baseUrlInput),
    labeled('API key', keyInput),
    labeled('Agent executable', agentExecutableInput),
    labeled('Agent arguments', agentArgsInput),
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
  let agentSessionId: string | null = null
  let agentSessionContext = ''
  let pendingAssistant: ChatMessage | null = null
  let historyState = emptyChatHistory()
  let activeConversationKey = GLOBAL_CHAT_CONVERSATION
  let historySaveQueue = Promise.resolve()

  const conversationLabel = (key: string): string => {
    if (key === GLOBAL_CHAT_CONVERSATION) return i18nT('common.generalChat')
    const context = historyState.contexts[key]
    if (context?.title) return context.title
    const project = context?.projectPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()
    return project || key
  }
  const refreshHistorySelect = (): void => {
    historySelect.replaceChildren(...Object.keys(historyState.conversations).map(key => Object.assign(document.createElement('option'), {
      value: key,
      textContent: conversationLabel(key),
    })))
    historySelect.value = activeConversationKey
    historyRefreshBtn.classList.toggle('hidden', !historyState.contexts[activeConversationKey]?.branch)
    historyRefreshBtn.classList.remove('ai-branch-stale')
    historyRefreshBtn.title = i18nT('common.updateReviewedBranch')
  }
  const persistHistory = (): void => {
    historyState.activeConversation = activeConversationKey
    historyState.conversations[activeConversationKey] = messages
      .filter(message => message !== pendingAssistant)
      .slice(-MAX_HISTORY)
    const content = serializeChatHistory(historyState)
    historySaveQueue = historySaveQueue
      .then(() => invoke('chat_history_save', { content }))
      .then(() => undefined)
      .catch(() => {})
  }
  const switchConversation = (key: string): void => {
    if (!key || key === activeConversationKey) return
    persistHistory()
    activeConversationKey = key
    historyState.activeConversation = key
    messages.splice(0, messages.length, ...(historyState.conversations[key] ?? []))
    historyState.conversations[key] ??= []
    agentSessionId = null
    agentSessionContext = ''
    const context = historyState.contexts[key]
    if (context) {
      setActiveProjectPath(context.projectPath)
      cfg = { ...cfg, providerId: 'agent' }
      agentSelect.value = context.agentType
      applyConfigToUi()
    }
    refreshHistorySelect()
    renderThread()
    persistHistory()
  }
  const historyReady = invoke<string>('chat_history_load')
    .then(raw => {
      historyState = parseChatHistory(raw)
      activeConversationKey = historyState.activeConversation
      messages.splice(0, messages.length, ...(historyState.conversations[activeConversationKey] ?? []))
      const savedContext = historyState.contexts[activeConversationKey]
      if (savedContext) {
        setActiveProjectPath(savedContext.projectPath)
        cfg = { ...cfg, providerId: 'agent' }
        agentSelect.value = savedContext.agentType
        applyConfigToUi()
      }
      refreshHistorySelect()
      renderThread()
    })
    .catch(() => { historyState = emptyChatHistory() })

  historySelect.addEventListener('change', () => {
    if (streaming) { historySelect.value = activeConversationKey; return }
    switchConversation(historySelect.value)
  })

  historyRefreshBtn.addEventListener('click', () => {
    void (async () => {
      await historyReady
      if (streaming) return
      const context = historyState.contexts[activeConversationKey]
      if (!context?.branch) return
      streaming = true
      root.classList.add('busy')
      historySelect.disabled = true
      historyRefreshBtn.disabled = true
      clearBtn.disabled = true
      let managedBranchContext = false
      try {
        if (context.commit) {
          const checked = await invoke<ReviewBranchContextResult>('review_branch_context_check', {
            repoPath: context.projectPath,
            reference: context.branch,
            commit: context.commit,
          })
          managedBranchContext ||= checked.managed
          if (!checked.stale) {
            messages.push({ role: 'assistant', content: i18nT('common.reviewBranchUpToDate', { branch: context.branch }) })
            renderThread()
            persistHistory()
            return
          }
          if (!window.confirm(i18nT('common.updateReviewedBranchQuestion', {
            branch: context.branch,
            old: context.commit.slice(0, 7),
            next: checked.latestCommit.slice(0, 7),
          }))) return
        }
        const previous = context.commit
        const updated = await invoke<ReviewBranchContextResult>('review_branch_context_update', {
          repoPath: context.projectPath,
          reference: context.branch,
        })
        managedBranchContext ||= updated.managed
        context.commit = updated.commit
        historyRefreshBtn.classList.remove('ai-branch-stale')
        historyRefreshBtn.title = i18nT('common.updateReviewedBranch')
        agentSessionId = null
        agentSessionContext = ''
        messages.push({
          role: 'assistant',
          content: previous
            ? i18nT('common.reviewBranchUpdated', { branch: context.branch, old: previous.slice(0, 7), next: updated.commit.slice(0, 7) })
            : i18nT('common.reviewBranchReady', { branch: context.branch, commit: updated.commit.slice(0, 7) }),
        })
        renderThread()
        persistHistory()
      } catch (error) {
        messages.push({ role: 'assistant', content: `⚠️ ${error instanceof Error ? error.message : String(error)}` })
        renderThread()
        persistHistory()
      } finally {
        if (managedBranchContext) {
          await invoke('review_branch_context_release', {
            repoPath: context.projectPath,
            reference: context.branch,
          }).catch(() => {})
        }
        streaming = false
        root.classList.remove('busy')
        historySelect.disabled = false
        historyRefreshBtn.disabled = false
        clearBtn.disabled = false
      }
    })()
  })

  const applyConfigToUi = (): void => {
    providerSelect.value = cfg.providerId
    modelSelect.value = cfg.model
    baseUrlInput.value = cfg.baseUrl
    systemInput.value = cfg.systemPrompt
    agentExecutableInput.value = cfg.agentExecutable ?? ''
    agentArgsInput.value = cfg.agentArgs ?? ''
    keyInput.placeholder = i18nT('common.aiKeyPlaceholder', {
      provider: providerById(cfg.providerId)?.label ?? i18nT('common.provider'),
    })
    refreshModelSuggestions()
    agentSelect.classList.toggle('hidden', cfg.providerId !== 'agent')
    const showCustomAgent = cfg.providerId === 'agent' && agentSelect.value === 'custom'
    document.querySelectorAll('.ai-agent-config').forEach(el => el.classList.toggle('hidden', !showCustomAgent))
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
  agentSelect.addEventListener('change', () => {
    document.querySelectorAll('.ai-agent-config').forEach(el => el.classList.toggle('hidden', agentSelect.value !== 'custom'))
  })
  agentExecutableInput.addEventListener('change', () => { cfg = { ...cfg, agentExecutable: agentExecutableInput.value.trim() }; persist() })
  agentArgsInput.addEventListener('change', () => { cfg = { ...cfg, agentArgs: agentArgsInput.value }; persist() })
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
      row.classList.toggle('ai-msg-pending', m === pendingAssistant)
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
    await historyReady
    const text = input.value.trim()
    if (!text || streaming) return
    if (cfg.providerId === 'agent') {
      await sendToAgent(text)
      return
    }
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
    historySelect.disabled = true
    historyRefreshBtn.disabled = true
    clearBtn.disabled = true
    try {
      if (tools?.length) await runWithTools(apiMessages, assistant, apiKey)
      else await streamReply(apiMessages, assistant, apiKey)
    } catch (e) {
      assistant.content = `⚠️ ${e instanceof Error ? e.message : 'Fallo de red'}`
      renderThread()
    } finally {
      streaming = false
      root.classList.remove('busy')
      historySelect.disabled = false
      historyRefreshBtn.disabled = false
      clearBtn.disabled = false
      persistHistory()
    }
  }

  async function sendToAgent(text: string): Promise<void> {
    const conversationContext = historyState.contexts[activeConversationKey]
    const sourceProjectPath = conversationContext?.projectPath ?? getActiveProjectPath()
    if (!sourceProjectPath) {
      settings.classList.remove('hidden')
      return
    }
    input.value = ''
    input.style.height = 'auto'
    messages.push({ role: 'user', content: expandInput(text) })
    const agent = agentSelect.value as 'claude' | 'opencode' | 'codex' | 'custom'
    const agentLabel = agent === 'claude' ? 'Claude' : agent === 'opencode' ? 'OpenCode' : agent === 'codex' ? 'Codex' : 'Agent'
    const assistant: ChatMessage = { role: 'assistant', content: i18nT('common.agentWorking', { agent: agentLabel }) }
    pendingAssistant = assistant
    messages.push(assistant)
    renderThread()
    persistHistory()
    streaming = true
    root.classList.add('busy')
    sendBtn.disabled = true
    historySelect.disabled = true
    historyRefreshBtn.disabled = true
    clearBtn.disabled = true
    let managedBranchContext = false
    let projectPath = sourceProjectPath
    if (conversationContext?.branch) {
      try {
        const branchContext = await invoke<ReviewBranchContextResult>('review_branch_context_prepare', {
          repoPath: conversationContext.projectPath,
          reference: conversationContext.branch,
          commit: conversationContext.commit ?? null,
        })
        projectPath = branchContext.path
        managedBranchContext = branchContext.managed
        conversationContext.commit = branchContext.commit
        historyRefreshBtn.classList.toggle('ai-branch-stale', branchContext.stale)
        historyRefreshBtn.title = branchContext.stale
          ? i18nT('common.reviewBranchHasUpdates', { branch: conversationContext.branch })
          : i18nT('common.updateReviewedBranch')
        persistHistory()
      } catch (error) {
        assistant.content = `⚠️ ${error instanceof Error ? error.message : String(error)}`
        pendingAssistant = null
        streaming = false
        root.classList.remove('busy')
        sendBtn.disabled = false
        historySelect.disabled = false
        historyRefreshBtn.disabled = false
        clearBtn.disabled = false
        renderThread()
        persistHistory()
        return
      }
    }
    const sessionContext = `${agent}\0${projectPath}\0${conversationContext?.commit ?? ''}`
    let awaitingFirstChunk = true
    const handle = startAgent({
      agent,
      message: expandInput(text),
      history: messages.slice(0, -1),
      projectPath,
      sessionId: agentSessionContext === sessionContext ? agentSessionId : null,
      customExecutable: agentExecutableInput.value.trim() || undefined,
      customArgs: agentArgsInput.value.trim() ? agentArgsInput.value.trim().split(/\s+/) : undefined,
      review: Boolean(conversationContext?.branch),
      cleanupProjectPath: managedBranchContext,
    }, chunk => {
      if (awaitingFirstChunk) { assistant.content = ''; awaitingFirstChunk = false; pendingAssistant = null }
      assistant.content += chunk
      renderThread()
      persistHistory()
    }, sessionId => {
      agentSessionId = sessionId
      agentSessionContext = sessionContext
      if (awaitingFirstChunk) assistant.content = i18nT('common.emptyModelResponse')
      pendingAssistant = null
      renderThread()
    }, error => {
      assistant.content = `⚠️ ${error}`
      pendingAssistant = null
      renderThread()
    }, tool => {
      if (awaitingFirstChunk) { assistant.content = `${agentLabel}: ${tool}`; renderThread() }
    })
    try { await handle.ready; await handle.completed }
    catch (error) { assistant.content = `⚠️ ${error instanceof Error ? error.message : String(error)}`; renderThread() }
    finally {
      pendingAssistant = null
      streaming = false
      root.classList.remove('busy')
      sendBtn.disabled = false
      historySelect.disabled = false
      historyRefreshBtn.disabled = false
      clearBtn.disabled = false
      handle.unlisten()
      if (managedBranchContext && conversationContext?.branch) {
        await invoke('review_branch_context_release', {
          repoPath: conversationContext.projectPath,
          reference: conversationContext.branch,
        }).catch(() => {})
      }
      renderThread()
      persistHistory()
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
    fabPosition = { x: dragX, y: dragY }
    modal.classList.remove('hidden')
    root.classList.add('open')
    clampPosition()
    applyConfigToUi()
    loadKeyField()
    renderThread()
    input.focus()
  }
  const close = (): void => {
    modal.classList.add('hidden')
    root.classList.remove('open')
    dragX = fabPosition.x
    dragY = fabPosition.y
    root.style.setProperty('--ai-drag-x', `${dragX}px`)
    root.style.setProperty('--ai-drag-y', `${dragY}px`)
    savePosition()
  }
  const toggleOpen = (): void => (modal.classList.contains('hidden') ? open() : close())

  toggle.addEventListener('click', e => {
    if (root.dataset.dragged === 'true') {
      root.dataset.dragged = 'false'
      e.preventDefault()
      return
    }
    toggleOpen()
  })
  clearBtn.addEventListener('click', () => {
    if (streaming) return
    if (activeConversationKey !== GLOBAL_CHAT_CONVERSATION) {
      const deletedContext = historyState.contexts[activeConversationKey]
      delete historyState.conversations[activeConversationKey]
      delete historyState.contexts[activeConversationKey]
      activeConversationKey = Object.keys(historyState.conversations).at(-1) ?? GLOBAL_CHAT_CONVERSATION
      historyState.conversations[activeConversationKey] ??= []
      historyState.activeConversation = activeConversationKey
      messages.splice(0, messages.length, ...historyState.conversations[activeConversationKey])
      agentSessionId = null
      agentSessionContext = ''
      const context = historyState.contexts[activeConversationKey]
      if (context) {
        setActiveProjectPath(context.projectPath)
        cfg = { ...cfg, providerId: 'agent' }
        agentSelect.value = context.agentType
        applyConfigToUi()
      }
      refreshHistorySelect()
      persistHistory()
      renderThread()
      if (deletedContext?.branch) {
        void invoke('review_branch_context_release', {
          repoPath: deletedContext.projectPath,
          reference: deletedContext.branch,
        }).catch(() => {})
      }
      return
    }
    messages.length = 0
    persistHistory()
    renderThread()
  })
  closeBtn.addEventListener('click', close)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'i') { e.preventDefault(); toggleOpen() }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close()
  })

  // Context from other panels: opens the chat with the text preloaded (or sends it).
  window.addEventListener(AI_ASK_EVENT, e => {
    void (async () => {
      await historyReady
      const detail = (e as CustomEvent<AiAskDetail>).detail
      runner = detail.runner // enables/clears the Run button depending on the origin
      tools = detail.tools   // enables/clears function-calling depending on the origin
      if (detail.conversationKey) switchConversation(detail.conversationKey)
      if (detail.projectPath) {
        setActiveProjectPath(detail.projectPath)
        cfg = { ...cfg, providerId: 'agent' }
        const agentType = ['claude', 'opencode', 'codex', 'custom'].includes(detail.agentType ?? '')
          ? detail.agentType as 'claude' | 'opencode' | 'codex' | 'custom'
          : 'claude'
        agentSelect.value = agentType
        historyState.contexts[activeConversationKey] = {
          projectPath: detail.projectPath,
          agentType,
          title: detail.conversationTitle,
          branch: detail.conversationBranch,
          commit: detail.conversationCommit,
        }
        refreshHistorySelect()
        applyConfigToUi()
        persist()
        persistHistory()
      }
      if (detail.inject) {
        messages.push({ role: detail.inject.role, content: detail.inject.content })
        renderThread()
        persistHistory()
      }
      open()
      input.value = detail.text
      input.dispatchEvent(new Event('input')) // recalculates the textarea height
      input.focus()
      if (detail.autoSend) void send()
    })()
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
