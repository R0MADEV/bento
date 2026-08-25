import { invoke } from '@tauri-apps/api/core'
import { t as i18nT } from '../../i18n'
import { agentLabel, toAgentType, type AgentType, type ChatMessage } from '../../core/ai/config'
import { expandInput } from '../../core/ai/prompts'
import { redact, resolvePersistedSessionId, buildReviewMessage } from '../../core/ai/agentClient'
import { startAgent } from '../../adapters/agentRunner'
import { isCapacityError } from '../../core/ai/capacityError'
import { pinnedFollowUpHistory, type ChatConversationContext } from '../../core/ai/chatHistory'

// Mandar un mensaje a un agente de CLI: preparar el worktree si la
// conversación es de una review, lanzarlo, reintentar con otro si el primero
// está saturado, y soltar el worktree pase lo que pase. Era la mitad del chat.

interface ReviewBranchContextResult {
  path: string
  commit: string
  latestCommit: string
  managed: boolean
  stale: boolean
}

async function verifyResumableSession(agent: AgentType, cwd: string, sessionId: string): Promise<string | null> {
  if (agent === 'claude') return (await invoke<boolean>('agent_claude_session_exists', { cwd, sessionId }).catch(() => false)) ? sessionId : null
  if (agent === 'codex') return (await invoke<boolean>('agent_codex_session_exists', { sessionId }).catch(() => false)) ? sessionId : null
  return sessionId
}

// Orden en el que ir cayendo cuando un agente se queda sin capacidad (custom
// no entra: necesita un ejecutable explícito). La transcripción lleva el
// contexto de uno a otro.
const FAILOVER_AGENTS: AgentType[] = ['claude', 'codex', 'opencode']

export interface AgentRunDeps {
  input: HTMLTextAreaElement
  agentSelect: HTMLSelectElement
  session: { id: string | null; context: string }
  context: () => ChatConversationContext | undefined
  conversationKey: () => string
  activeProjectPath: () => string
  messages: () => ChatMessage[]
  setPending: (message: ChatMessage | null) => void
  openSettings: () => void
  renderThread: () => void
  persistHistory: () => void
  beginBusy: () => void
  endBusy: () => void
  clearWorktreePath: (key: string) => void
  /// Marca (o quita) el aviso de que la rama revisada tiene commits nuevos.
  markBranchStale: (stale: boolean, branch?: string) => void
  customExecutable: () => string
  customArgs: () => string
}

export function buildAgentRun(deps: AgentRunDeps): (text: string) => Promise<void> {
  async function sendToAgent(text: string): Promise<void> {
    const conversationContext = deps.context()
    const conversationKey = deps.conversationKey()
    const sourceProjectPath = conversationContext?.projectPath ?? deps.activeProjectPath()
    if (!sourceProjectPath) {
      deps.openSettings()
      return
    }
    deps.input.value = ''
    deps.input.style.height = 'auto'
    deps.messages().push({ role: 'user', content: expandInput(text) })
    const agent = toAgentType(deps.agentSelect.value)
    const label = agentLabel(agent)
    const assistant: ChatMessage = { role: 'assistant', content: i18nT('common.agentWorking', { agent: label }) }
    deps.setPending(assistant)
    deps.messages().push(assistant)
    deps.renderThread()
    deps.persistHistory()
    deps.beginBusy()
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
          deps.persistHistory()
        }
        conversationContext.commit = branchContext.commit
        deps.markBranchStale(branchContext.stale, conversationContext.branch)
        deps.persistHistory()
      } catch (error) {
        assistant.content = `⚠️ ${error instanceof Error ? error.message : String(error)}`
        deps.setPending(null)
        deps.renderThread()
        deps.persistHistory()
        deps.endBusy()
        return
      }
    }
    const sessionContext = `${agent}\0${projectPath}\0${conversationContext?.commit ?? ''}`
    const rawSessionId = conversationContext?.branch
      ? resolvePersistedSessionId(conversationContext, agent, conversationContext?.commit ?? '')
      : (deps.session.context === sessionContext ? deps.session.id : null)
    // Run fresh if the session can't be resumed (else the agent exits with a bare
    // error). The review report is already in the history, so context is kept.
    const resumeSessionId = rawSessionId ? await verifyResumableSession(agent, projectPath, rawSessionId) : null
    // Always carry the review report as context, even in a long chat: the agent
    // only sees a recent window, so keep the first assistant message (the report)
    // pinned at the front when the conversation has grown past it.
    const buildFollowUpHistory = (): ChatMessage[] =>
      pinnedFollowUpHistory(deps.messages().slice(0, -1), Boolean(conversationContext?.branch))
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
        customExecutable: deps.customExecutable().trim() || undefined,
        customArgs: deps.customArgs().trim() ? deps.customArgs().trim().split(/\s+/) : undefined,
        review: Boolean(conversationContext?.branch),
        cleanupProjectPath: managedBranchContext,
      }, chunk => {
        if (awaitingFirstChunk) { assistant.content = ''; awaitingFirstChunk = false; deps.setPending(null) }
        assistant.content += chunk
        deps.renderThread()
        deps.persistHistory()
      }, sessionId => {
        if (conversationContext?.branch) {
          conversationContext.sessionId = sessionId ?? undefined
          conversationContext.sessionAgent = sessionId ? attemptAgent : undefined
          conversationContext.sessionCommit = sessionId ? conversationContext.commit : undefined
        } else {
          deps.session.id = sessionId
          deps.session.context = sessionContext
        }
        if (awaitingFirstChunk) assistant.content = i18nT('common.emptyModelResponse')
        deps.setPending(null)
        deps.renderThread()
      }, error => {
        attemptError = error
      }, tool => {
        const safeTool = redact(tool).slice(0, 1_000)
        if (conversationContext?.branch && !conversationContext.evidence?.includes(safeTool)) {
          conversationContext.evidence = [...(conversationContext.evidence ?? []), safeTool].slice(-100)
          deps.persistHistory()
        }
        if (awaitingFirstChunk) { assistant.content = `${attemptLabel}: ${safeTool}`; deps.renderThread() }
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
          deps.renderThread()
          runError = await runAttempt(fallback, null)
          if (!runError) { if (conversationContext?.branch) deps.agentSelect.value = fallback; break }
        }
      }
      if (runError) { assistant.content = `⚠️ ${runError}`; deps.renderThread() }
    } finally {
      deps.setPending(null)
      if (managedBranchContext && managedBranchContextPath) {
        await invoke('review_branch_context_release', {
          path: managedBranchContextPath,
        }).catch(() => {})
        deps.clearWorktreePath(conversationKey)
      }
      deps.renderThread()
      deps.persistHistory()
      deps.endBusy()
    }
  }

  return sendToAgent
}
