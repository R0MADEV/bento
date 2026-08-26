import { invoke } from '@tauri-apps/api/core'
import { buildAiChatDom } from './dom'
import { buildAiChatDrag } from './drag'
import { buildAiChatConversations } from './conversations'
import { buildAiChatSettings } from './settings'
import { buildAgentRun } from './agentRun'
import { buildSend } from './send'
import { buildBranchRefresh } from './branchRefresh'
import { providerById, AGENT_PROVIDER_ID } from '../../core/ai/providers'
import {
  loadConfig, saveConfig, toAgentType,
  type AiConfig, type ChatMessage, 
} from '../../core/ai/config'
import { setAiKey, vaultStatus } from '../../adapters/aiKeys'
import { renderMarkdown } from '../../core/notes/renderMarkdown'
import { t as i18nT } from '../../i18n'
import { AI_ASK_EVENT, type AiAskDetail, type AiQueryRunner, type AiTool } from '../askAi'
import type { MemoryRepository } from '../../ports/MemoryRepository'
import { getActiveProjectPath, setActiveProjectPath } from '../state/activeProject'
import { redact } from '../../core/ai/agentClient'
import { emptyChatHistory, GLOBAL_CHAT_CONVERSATION, parseChatHistory } from '../../core/ai/chatHistory'

const AI_POSITION_KEY = 'bento.ai.position.v2'

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
  const dom = buildAiChatDom(root)
  const {
    toggle, modal, header, historySelect, historyRefreshBtn, providerSelect, agentSelect,
    modelSelect, expandBtn, settingsBtn, clearBtn, closeBtn,
    settings, baseUrlInput, keyInput, systemInput, agentExecutableInput, agentArgsInput, thread, input, sendBtn,
  } = dom
  const { clampPosition, savePosition, position, moveTo } =
    buildAiChatDrag({ root, modal, toggle, header, storageKey: AI_POSITION_KEY }, { x: dragX, y: dragY })



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
  let idlePromise = Promise.resolve()
  let resolveIdle: (() => void) | undefined

  const beginOperation = (): void => {
    streaming = true
    idlePromise = new Promise<void>(resolve => { resolveIdle = resolve })
  }
  const endOperation = (): void => {
    streaming = false
    resolveIdle?.()
    resolveIdle = undefined
  }
  const waitForIdle = async (): Promise<void> => {
    if (streaming) await idlePromise
  }
  // Busy state shared by every send/refresh path: marks the operation in-flight
  // and disables the controls that must not run concurrently, and the reverse.
  const beginBusy = (): void => {
    beginOperation()
    root.classList.add('busy')
    sendBtn.disabled = true
    historySelect.disabled = true
    historyRefreshBtn.disabled = true
    clearBtn.disabled = true
  }
  const endBusy = (): void => {
    root.classList.remove('busy')
    sendBtn.disabled = false
    historySelect.disabled = false
    historyRefreshBtn.disabled = false
    clearBtn.disabled = false
    endOperation()
  }

  const {
    syncAgentSelectionState, refreshHistorySelect,
    persistHistory, clearConversationWorktreePath, switchConversation,
  } = buildAiChatConversations(dom, {
    history: () => historyState,
    activeKey: () => activeConversationKey,
    setActiveKey: (key: string) => { activeConversationKey = key },
    messages: () => messages,
    setMessages: (next: ChatMessage[]) => { messages.splice(0, messages.length, ...next) },
    pending: () => pendingAssistant,
    config: () => cfg,
    setConfig: (next: AiConfig) => { cfg = next },
    renderThread: () => renderThread(),
    applyConfigToUi: () => applyConfigToUi(),
    resetSession: () => { agentSessionId = null; agentSessionContext = '' },
  })


  const historyReady = invoke<string>('chat_history_load')
    .then(raw => {
      historyState = parseChatHistory(raw)
      activeConversationKey = historyState.activeConversation
      messages.splice(0, messages.length, ...(historyState.conversations[activeConversationKey] ?? []))
      const savedContext = historyState.contexts[activeConversationKey]
      if (savedContext) {
        setActiveProjectPath(savedContext.projectPath)
        cfg = { ...cfg, providerId: AGENT_PROVIDER_ID }
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
  const { applyConfigToUi, showVaultNotice, loadKeyField } = buildAiChatSettings(dom, () => cfg)

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
        if (m.role === 'assistant') {
          row.innerHTML = renderMarkdown(m.content)
        }
        else row.textContent = m.content
        thread.appendChild(row)
      })
    decorateRunButtons()
    thread.scrollTop = thread.scrollHeight
  }

  const agentSession = { id: agentSessionId, context: agentSessionContext }
  const sendToAgent = buildAgentRun({
    input,
    agentSelect,
    session: agentSession,
    context: () => historyState.contexts[activeConversationKey],
    conversationKey: () => activeConversationKey,
    activeProjectPath: getActiveProjectPath,
    messages: () => messages,
    setPending: (message: ChatMessage | null) => { pendingAssistant = message },
    openSettings: () => settings.classList.remove('hidden'),
    renderThread,
    persistHistory,
    beginBusy,
    endBusy,
    clearWorktreePath: clearConversationWorktreePath,
    customExecutable: () => agentExecutableInput.value,
    customArgs: () => agentArgsInput.value,
    markBranchStale: (stale: boolean, branch?: string) => {
      historyRefreshBtn.classList.toggle('ai-branch-stale', stale)
      historyRefreshBtn.title = stale
        ? i18nT('common.reviewBranchHasUpdates', { branch: branch ?? '' })
        : i18nT('common.updateReviewedBranch')
    },
  })

  // ── Streaming send ───────────────────────────────────────────────────────
  const send = buildSend({
    input, settings, memoryRepo, historyReady,
    config: () => cfg,
    messages: () => messages,
    tools: () => tools,
    isStreaming: () => streaming,
    setPending: (message: ChatMessage | null) => { pendingAssistant = message },
    sendToAgent: text => sendToAgent(text),
    showVaultNotice,
    renderThread,
    persistHistory,
    beginBusy,
    endBusy,
  })

  const refreshBranch = buildBranchRefresh({
    historyReady,
    isStreaming: () => streaming,
    context: () => historyState.contexts[activeConversationKey],
    messages: () => messages,
    persistHistory,
    renderThread,
    beginBusy,
    endBusy,
    sendToAgent,
    clearWorktreePath: () => clearConversationWorktreePath(activeConversationKey),
    onBranchUpdated: () => {
      historyRefreshBtn.classList.remove('ai-branch-stale')
      historyRefreshBtn.title = i18nT('common.updateReviewedBranch')
      agentSessionId = null
      agentSessionContext = ''
    },
  })
  historyRefreshBtn.addEventListener('click', refreshBranch)

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
    fabPosition = position()
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
    moveTo(fabPosition)
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
        cfg = { ...cfg, providerId: AGENT_PROVIDER_ID }
        agentSelect.value = context.agentType
        applyConfigToUi()
      }
      refreshHistorySelect()
      persistHistory()
      renderThread()
      if (deletedContext?.branch) {
        void invoke('review_branch_context_release', { path: deletedContext.worktreePath ?? deletedContext.projectPath }).catch(() => {})
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

  applyConfigToUi()
  syncAgentSelectionState()

  // Context from other panels: opens the chat with the text preloaded (or sends it).
  let askEventQueue = Promise.resolve()
  window.addEventListener(AI_ASK_EVENT, e => {
    const detail = (e as CustomEvent<AiAskDetail>).detail
    askEventQueue = askEventQueue.then(async () => {
      await historyReady
      await waitForIdle()
      runner = detail.runner // enables/clears the Run button depending on the origin
      tools = detail.tools   // enables/clears function-calling depending on the origin
      if (detail.conversationKey) switchConversation(detail.conversationKey)
      if (detail.projectPath) {
        setActiveProjectPath(detail.projectPath)
        cfg = { ...cfg, providerId: AGENT_PROVIDER_ID }
        const agentType = toAgentType(detail.agentType ?? '')
        agentSelect.value = agentType
        historyState.contexts[activeConversationKey] = {
          projectPath: detail.projectPath,
          agentType,
          title: detail.conversationTitle,
          branch: detail.conversationBranch,
          commit: detail.conversationCommit,
          sessionId: detail.conversationSessionId,
          sessionAgent: detail.conversationSessionId ? toAgentType(detail.conversationSessionAgent ?? agentType) : undefined,
          sessionCommit: detail.conversationSessionId ? detail.conversationCommit : undefined,
          evidence: (detail.conversationEvidence ?? []).map(item => redact(item).slice(0, 1_000)).slice(-100),
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
      if (detail.autoSend) await send()
    }).catch((error) => {
      console.error('[AI Chat] Failed to process an incoming review request', error)
    })
  })

  return root
}
