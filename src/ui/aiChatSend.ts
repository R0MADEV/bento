import { AGENT_PROVIDER_ID } from '../core/ai/providers'
import { chatEndpoint, runWithTools, streamChat } from '../core/ai/chatApi'
import { expandInput } from '../core/ai/prompts'
import { buildMemoryContext, selectMemoryForPrompt } from '../core/memory/aiContext'
import { getAiKey } from '../adapters/aiKeys'
import { vaultStatus } from '../adapters/aiKeys'
import { getActiveProjectPath } from './state/activeProject'
import type { AiConfig, ChatMessage } from '../core/ai/config'
import type { MemoryRepository } from '../ports/MemoryRepository'
import type { AiTool } from './askAi'

// Mandar un mensaje al modelo por HTTP: memoria del proyecto como contexto de
// sistema, herramientas si el panel las ofrece, y streaming si no.

export interface SendDeps {
  input: HTMLTextAreaElement
  settings: HTMLElement
  memoryRepo: MemoryRepository
  historyReady: Promise<unknown>
  config: () => AiConfig
  messages: () => ChatMessage[]
  tools: () => AiTool[] | undefined
  isStreaming: () => boolean
  setPending: (message: ChatMessage | null) => void
  sendToAgent: (text: string) => Promise<void>
  showVaultNotice: (status: Awaited<ReturnType<typeof vaultStatus>>) => void
  renderThread: () => void
  persistHistory: () => void
  beginBusy: () => void
  endBusy: () => void
}

export function buildSend(deps: SendDeps): () => Promise<void> {
  async function send(): Promise<void> {
    await deps.historyReady
    const text = deps.input.value.trim()
    if (!text || deps.isStreaming()) return
    if (deps.config().providerId === AGENT_PROVIDER_ID) {
      await deps.sendToAgent(text)
      return
    }
    const status = await vaultStatus()
    if (status !== 'unlocked') {
      deps.settings.classList.remove('hidden')
      deps.showVaultNotice(status)
      return
    }
    const apiKey = await getAiKey(deps.config().providerId)
    if (!apiKey || !deps.config().baseUrl) {
      deps.settings.classList.remove('hidden')
      return
    }

    deps.input.value = ''
    deps.input.style.height = 'auto'
    // Slash commands (/traducir, /explica…) expand into a full prompt.
    deps.messages().push({ role: 'user', content: expandInput(text) })
    const assistant: ChatMessage = { role: 'assistant', content: '' }
    deps.messages().push(assistant)
    deps.renderThread()

    // History without the assistant placeholder; the project memory is sent as
    // private system context and is never added to the visible conversation.
    const history = deps.messages().slice(0, -1)
    const projectPath = getActiveProjectPath()
    const memory = projectPath
      ? await deps.memoryRepo.list(projectPath).then(entries => buildMemoryContext(selectMemoryForPrompt(entries, text), projectPath)).catch(() => null)
      : null
    const systemMessages: ChatMessage[] = [
      ...(deps.config().systemPrompt ? [{ role: 'system' as const, content: deps.config().systemPrompt }] : []),
      ...(memory ? [{ role: 'system' as const, content: memory }] : []),
    ]
    const apiMessages: ChatMessage[] = [...systemMessages, ...history]

    deps.beginBusy()
    try {
      const endpoint = chatEndpoint(deps.config().baseUrl, deps.config().model, apiKey)
      if (deps.tools()?.length) {
        assistant.content = await runWithTools(endpoint, apiMessages, deps.tools() ?? [], () => {
          assistant.content = '🔧 Consultando el esquema…'
          deps.renderThread()
        })
      } else {
        await streamChat(endpoint, apiMessages, delta => { assistant.content += delta; deps.renderThread() })
      }
      deps.renderThread()
    } catch (e) {
      assistant.content = `⚠️ ${e instanceof Error ? e.message : 'Fallo de red'}`
      deps.renderThread()
    } finally {
      deps.persistHistory()
      deps.endBusy()
    }
  }

  return send
}
