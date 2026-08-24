import { invoke } from '@tauri-apps/api/core'
import { buildAiChatDom } from './aiChatDom'
import { providerById, AGENT_PROVIDER_ID } from '../core/ai/providers'
import {
  loadConfig, saveConfig, agentLabel, toAgentType,
  type AiConfig, type ChatMessage, type AgentType,
} from '../core/ai/config'
import { getAiKey, setAiKey, vaultStatus, type VaultStatus } from '../adapters/aiKeys'
import { chatEndpoint, runWithTools, streamChat } from '../core/ai/chatApi'
import { renderMarkdown } from '../core/notes/renderMarkdown'
import { t as i18nT } from '../i18n'
import { expandInput } from '../core/ai/prompts'
import { AI_ASK_EVENT, type AiAskDetail, type AiQueryRunner, type AiTool } from './askAi'
import type { MemoryRepository } from '../ports/MemoryRepository'
import { getActiveProjectPath, setActiveProjectPath } from './state/activeProject'
import { buildMemoryContext, selectMemoryForPrompt } from '../core/memory/aiContext'
import { redact, startAgent, resolvePersistedSessionId, buildReviewMessage } from '../core/ai/agentClient'
import { emptyChatHistory, GLOBAL_CHAT_CONVERSATION, parseChatHistory, pinnedFollowUpHistory, serializeChatHistory } from '../core/ai/chatHistory'
import { isCapacityError } from '../core/ai/capacityError'
import { getUiZoom, toLayoutPixels } from './helpers/zoom'
import { clampToViewport } from './helpers/floatingPosition'

const AI_POSITION_KEY = 'bento.ai.position.v2'
const MAX_HISTORY = 200

interface ReviewBranchContextResult { path: string; commit: string; latestCommit: string; managed: boolean; stale: boolean }

// Resuming a review/chat session that no longer exists makes the agent CLI exit
// with a bare error. Verify it first (as the Agents panel does); return null to
// run fresh — the review report stays in the chat history, so context survives.
async function verifyResumableSession(agent: AgentType, cwd: string, sessionId: string): Promise<string | null> {
  if (agent === 'claude') return (await invoke<boolean>('agent_claude_session_exists', { cwd, sessionId }).catch(() => false)) ? sessionId : null
  if (agent === 'codex') return (await invoke<boolean>('agent_codex_session_exists', { sessionId }).catch(() => false)) ? sessionId : null
  return sessionId
}

// Order to fall over through when an agent runs out of capacity (custom excluded:
// it needs an explicit executable). The transcript carries the context across.
const FAILOVER_AGENTS: AgentType[] = ['claude', 'codex', 'opencode']

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
  const {
    toggle, modal, header, historySelect, historyRefreshBtn, providerSelect, modeBadge, agentSelect,
    reviewAgentBadge, modelSelect, modelList, expandBtn, settingsBtn, clearBtn, closeBtn,
    settings, baseUrlInput, keyInput, systemInput, agentExecutableInput, agentArgsInput, vaultNotice,
    thread, input, sendBtn,
  } = buildAiChatDom(root)


  const clampPosition = (): void => {
    const zoom = getUiZoom()
    const collapsed = modal.classList.contains('hidden')
    const clamped = clampToViewport(
      { x: dragX, y: dragY },
      {
        width: (collapsed ? toggle.offsetWidth : modal.offsetWidth) || (collapsed ? 44 : 460),
        height: (collapsed ? toggle.offsetHeight : modal.offsetHeight) || (collapsed ? 44 : 320),
      },
      { width: window.innerWidth / zoom, height: window.innerHeight / zoom },
    )
    dragX = clamped.x
    dragY = clamped.y
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

  const conversationLabel = (key: string): string => {
    if (key === GLOBAL_CHAT_CONVERSATION) return i18nT('common.generalChat')
    const context = historyState.contexts[key]
    if (context?.title) return context.title
    const project = context?.projectPath.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()
    return project || key
  }
  const syncAgentSelectionState = (): void => {
    const context = historyState.contexts[activeConversationKey]
    const locked = Boolean(context?.branch)
    agentSelect.disabled = locked
    agentSelect.title = locked ? i18nT('common.reviewAgentLocked') : ''
    modeBadge.textContent = cfg.providerId === AGENT_PROVIDER_ID
      ? i18nT('common.aiModeAgent')
      : i18nT('common.aiModeChat')
    reviewAgentBadge.classList.toggle('hidden', !locked)
    reviewAgentBadge.textContent = locked
      ? i18nT('common.reviewAgentFixed', { agent: agentLabel(toAgentType(agentSelect.value)) })
      : ''
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
    syncAgentSelectionState()
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
  const clearConversationWorktreePath = (key: string): void => {
    const context = historyState.contexts[key]
    if (!context?.worktreePath) return
    delete context.worktreePath
    persistHistory()
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
      cfg = { ...cfg, providerId: AGENT_PROVIDER_ID }
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

  historyRefreshBtn.addEventListener('click', () => {
    void (async () => {
      await historyReady
      if (streaming) return
      const context = historyState.contexts[activeConversationKey]
      if (!context?.branch) return
      beginBusy()
      let managedBranchContext = false
      let managedBranchContextPath: string | null = null
      try {
        if (context.commit) {
          const checked = await invoke<ReviewBranchContextResult>('review_branch_context_check', {
            repoPath: context.projectPath,
            reference: context.branch,
            commit: context.commit,
          })
          managedBranchContext ||= checked.managed
          managedBranchContextPath = checked.managed ? checked.path : managedBranchContextPath
          if (checked.managed) {
            context.worktreePath = checked.path
            persistHistory()
          }
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
        managedBranchContextPath = updated.managed ? updated.path : managedBranchContextPath
        if (updated.managed) {
          context.worktreePath = updated.path
          persistHistory()
        }
        context.commit = updated.commit
        context.sessionId = undefined
        context.sessionAgent = undefined
        context.sessionCommit = undefined
        context.evidence = []
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
        if (managedBranchContext && managedBranchContextPath) {
          await invoke('review_branch_context_release', {
            path: managedBranchContextPath,
          }).catch(() => {})
          clearConversationWorktreePath(activeConversationKey)
        }
        endBusy()
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
    const showCustomAgent = cfg.providerId === AGENT_PROVIDER_ID && agentSelect.value === 'custom'
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
        if (m.role === 'assistant') {
          row.innerHTML = renderMarkdown(m.content)
        }
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
    if (cfg.providerId === AGENT_PROVIDER_ID) {
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

    beginBusy()
    try {
      const endpoint = chatEndpoint(cfg.baseUrl, cfg.model, apiKey)
      if (tools?.length) {
        assistant.content = await runWithTools(endpoint, apiMessages, tools, () => {
          assistant.content = '🔧 Consultando el esquema…'
          renderThread()
        })
      } else {
        await streamChat(endpoint, apiMessages, delta => { assistant.content += delta; renderThread() })
      }
      renderThread()
    } catch (e) {
      assistant.content = `⚠️ ${e instanceof Error ? e.message : 'Fallo de red'}`
      renderThread()
    } finally {
      persistHistory()
      endBusy()
    }
  }

  async function sendToAgent(text: string): Promise<void> {
    const conversationContext = historyState.contexts[activeConversationKey]
    const conversationKey = activeConversationKey
    const sourceProjectPath = conversationContext?.projectPath ?? getActiveProjectPath()
    if (!sourceProjectPath) {
      settings.classList.remove('hidden')
      return
    }
    input.value = ''
    input.style.height = 'auto'
    messages.push({ role: 'user', content: expandInput(text) })
    const agent = toAgentType(agentSelect.value)
    const label = agentLabel(agent)
    const assistant: ChatMessage = { role: 'assistant', content: i18nT('common.agentWorking', { agent: label }) }
    pendingAssistant = assistant
    messages.push(assistant)
    renderThread()
    persistHistory()
    beginBusy()
    let managedBranchContext = false
    let managedBranchContextPath: string | null = null
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
        managedBranchContextPath = branchContext.managed ? branchContext.path : managedBranchContextPath
        if (branchContext.managed) {
          conversationContext.worktreePath = branchContext.path
          persistHistory()
        }
        conversationContext.commit = branchContext.commit
        historyRefreshBtn.classList.toggle('ai-branch-stale', branchContext.stale)
        historyRefreshBtn.title = branchContext.stale
          ? i18nT('common.reviewBranchHasUpdates', { branch: conversationContext.branch })
          : i18nT('common.updateReviewedBranch')
        persistHistory()
      } catch (error) {
        assistant.content = `⚠️ ${error instanceof Error ? error.message : String(error)}`
        pendingAssistant = null
        renderThread()
        persistHistory()
        endBusy()
        return
      }
    }
    const sessionContext = `${agent}\0${projectPath}\0${conversationContext?.commit ?? ''}`
    const rawSessionId = conversationContext?.branch
      ? resolvePersistedSessionId(conversationContext, agent, conversationContext?.commit ?? '')
      : (agentSessionContext === sessionContext ? agentSessionId : null)
    // Run fresh if the session can't be resumed (else the agent exits with a bare
    // error). The review report is already in the history, so context is kept.
    const resumeSessionId = rawSessionId ? await verifyResumableSession(agent, projectPath, rawSessionId) : null
    // Always carry the review report as context, even in a long chat: the agent
    // only sees a recent window, so keep the first assistant message (the report)
    // pinned at the front when the conversation has grown past it.
    const buildFollowUpHistory = (): ChatMessage[] =>
      pinnedFollowUpHistory(messages.slice(0, -1), Boolean(conversationContext?.branch))
    let awaitingFirstChunk = true
    const runAttempt = async (attemptAgent: AgentType, resumeId: string | null): Promise<string | null> => {
      awaitingFirstChunk = true
      const attemptLabel = agentLabel(attemptAgent)
      let attemptError: string | null = null
      const handle = startAgent({
        agent: attemptAgent,
        message: buildReviewMessage(expandInput(text), conversationContext?.evidence, Boolean(resumeId)),
        history: buildFollowUpHistory(),
        projectPath,
        sessionId: resumeId,
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
        if (conversationContext?.branch) {
          conversationContext.sessionId = sessionId ?? undefined
          conversationContext.sessionAgent = sessionId ? attemptAgent : undefined
          conversationContext.sessionCommit = sessionId ? conversationContext.commit : undefined
        } else {
          agentSessionId = sessionId
          agentSessionContext = sessionContext
        }
        if (awaitingFirstChunk) assistant.content = i18nT('common.emptyModelResponse')
        pendingAssistant = null
        renderThread()
      }, error => {
        attemptError = error
      }, tool => {
        const safeTool = redact(tool).slice(0, 1_000)
        if (conversationContext?.branch && !conversationContext.evidence?.includes(safeTool)) {
          conversationContext.evidence = [...(conversationContext.evidence ?? []), safeTool].slice(-100)
          persistHistory()
        }
        if (awaitingFirstChunk) { assistant.content = `${attemptLabel}: ${safeTool}`; renderThread() }
      })
      try { await handle.ready; await handle.completed }
      catch (error) { attemptError = error instanceof Error ? error.message : String(error) }
      finally { handle.unlisten() }
      return attemptError
    }

    try {
      // 1) resume the last agent's session; 2) if that fails, same agent fresh;
      // 3) if it hit a token/rate limit, continue with another agent — the transcript
      // (incl. the review report) travels as context, so no session transfer is needed.
      let runError = await runAttempt(agent, resumeSessionId)
      if (runError && resumeSessionId) runError = await runAttempt(agent, null)
      if (runError && isCapacityError(runError)) {
        for (const fallback of FAILOVER_AGENTS) {
          if (fallback === agent) continue
          assistant.content = i18nT('common.agentWorking', { agent: agentLabel(fallback) })
          renderThread()
          runError = await runAttempt(fallback, null)
          if (!runError) { if (conversationContext?.branch) agentSelect.value = fallback; break }
        }
      }
      if (runError) { assistant.content = `⚠️ ${runError}`; renderThread() }
    } finally {
      pendingAssistant = null
      if (managedBranchContext && managedBranchContextPath) {
        await invoke('review_branch_context_release', {
          path: managedBranchContextPath,
        }).catch(() => {})
        clearConversationWorktreePath(conversationKey)
      }
      renderThread()
      persistHistory()
      endBusy()
    }
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
