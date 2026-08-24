import { buildChatBody, type ChatMessage } from './config'
import { splitLines, deltaFromLine, isDoneLine } from './sseStream'
import type { AiTool } from '../../ui/askAi'

// Las dos formas de hablar con una API compatible con OpenAI: streaming para
// una respuesta normal, y un bucle sin streaming cuando el modelo puede pedir
// herramientas. Vivían dentro del closure de `createAiChat`, donde no había
// forma de probarlas.

// Mensajes tal y como los espera la API (con tool_calls y respuestas de tool).
interface ApiToolCall { id: string; function: { name: string; arguments: string } }
interface ApiMessage { role: string; content?: string | null; tool_calls?: ApiToolCall[]; tool_call_id?: string }

export interface ChatEndpoint {
  url: string
  headers: Record<string, string>
  model: string
}

export function chatEndpoint(baseUrl: string, model: string, apiKey: string): ChatEndpoint {
  return {
    url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    model,
  }
}

// Cuántas veces seguidas puede el modelo pedir herramientas antes de que demos
// el turno por perdido.
const MAX_TOOL_ROUNDS = 6

async function failure(res: Response): Promise<Error> {
  return new Error(`Error ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

/// Llama al modelo y va entregando el texto según llega.
export async function streamChat(endpoint: ChatEndpoint, messages: ChatMessage[], onDelta: (delta: string) => void): Promise<void> {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: endpoint.headers,
    body: JSON.stringify(buildChatBody(messages, endpoint.model)),
  })
  if (!res.ok || !res.body) throw await failure(res)

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
      if (delta) onDelta(delta)
    }
  }
}

/// Con herramientas: bucle sin streaming. El modelo pide datos (get_columns…),
/// los ejecutamos y se los devolvemos hasta que produce la respuesta final.
/// Una herramienta que falla devuelve su error al modelo, que sabe seguir; lo
/// que no puede es tragarse el fallo en silencio.
export async function runWithTools(
  endpoint: ChatEndpoint,
  messages: ChatMessage[],
  tools: AiTool[],
  onToolRound: () => void,
): Promise<string> {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const conversation: ApiMessage[] = [...messages]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: JSON.stringify({ model: endpoint.model, messages: conversation, tools: tools.map(t => t.schema), tool_choice: 'auto' }),
    })
    if (!res.ok) throw await failure(res)

    const data = await res.json() as { choices?: Array<{ message?: ApiMessage }> }
    const reply = data.choices?.[0]?.message
    if (!reply) throw new Error('empty model response')
    if (!reply.tool_calls?.length) return reply.content ?? ''

    conversation.push(reply)
    onToolRound()
    for (const call of reply.tool_calls) {
      const tool = byName.get(call.function?.name)
      let result = 'herramienta desconocida'
      if (tool) {
        try { result = await tool.run(JSON.parse(call.function.arguments || '{}')) }
        catch (err) { result = `error: ${err instanceof Error ? err.message : String(err)}` }
      }
      conversation.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }
  throw new Error('too many tool calls')
}
