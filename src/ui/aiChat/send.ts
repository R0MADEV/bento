import { AGENT_PROVIDER_ID } from '../../core/ai/providers'
import { chatEndpoint, runWithTools, streamChat } from '../../core/ai/chatApi'
import { expandInput } from '../../core/ai/prompts'
import { getAiKey } from '../../adapters/aiKeys'
import { vaultStatus } from '../../adapters/aiKeys'
import type { AiConfig, ChatMessage } from '../../core/ai/config'
import type { AiTool } from '../askAi'

// Mandar un mensaje al modelo por HTTP: memoria del proyecto como contexto de
// sistema, herramientas si el panel las ofrece, y streaming si no.

export interface SendDeps {
  input: HTMLTextAreaElement
  settings: HTMLElement
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

    // History without the assistant placeholder.
    const history = deps.messages().slice(0, -1)
    const systemMessages: ChatMessage[] = deps.config().systemPrompt
      ? [{ role: 'system' as const, content: deps.config().systemPrompt }]
      : []
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
