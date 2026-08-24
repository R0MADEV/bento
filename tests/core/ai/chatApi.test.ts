import { describe, expect, it, vi } from 'vitest'
import { chatEndpoint, streamChat, runWithTools } from '../../../src/core/ai/chatApi'
import type { AiTool } from '../../../src/ui/askAi'

const endpoint = chatEndpoint('https://api.example.com/v1/', 'gpt-x', 'sk-123')

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      lines.forEach(l => controller.enqueue(new TextEncoder().encode(`${l}\n`)))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

describe('chatEndpoint', () => {
  it('builds the completions URL without doubling the slash', () => {
    expect(endpoint.url).toBe('https://api.example.com/v1/chat/completions')
    expect(chatEndpoint('https://x/v1', 'm', 'k').url).toBe('https://x/v1/chat/completions')
  })

  it('carries the key in the Authorization header', () => {
    expect(endpoint.headers.Authorization).toBe('Bearer sk-123')
  })
})

describe('streamChat', () => {
  it('reports each delta as it arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hola"}}]}',
      'data: {"choices":[{"delta":{"content":" mundo"}}]}',
      'data: [DONE]',
    ])))
    const deltas: string[] = []
    await streamChat(endpoint, [], d => deltas.push(d))
    expect(deltas).toEqual(['Hola', ' mundo'])
  })

  it('fails with the status and the body when the API rejects the call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no key', { status: 401 })))
    await expect(streamChat(endpoint, [], () => {})).rejects.toThrow(/401.*no key/)
  })
})

describe('runWithTools', () => {
  const columns: AiTool = {
    name: 'get_columns',
    schema: {} as AiTool['schema'],
    run: vi.fn(async () => 'id, name'),
  }

  it('executes the tool the model asks for and returns its final answer', async () => {
    const responses = [
      { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'get_columns', arguments: '{}' } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'La tabla tiene id y name' } }] },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })))
    await expect(runWithTools(endpoint, [], [columns], () => {})).resolves.toBe('La tabla tiene id y name')
    expect(columns.run).toHaveBeenCalled()
  })

  it('reports a tool that throws instead of losing the turn', async () => {
    const broken: AiTool = { name: 'boom', schema: {} as AiTool['schema'], run: async () => { throw new Error('sin conexión') } }
    const sent: unknown[] = []
    const responses = [
      { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'boom', arguments: '{}' } }] } }] },
      { choices: [{ message: { role: 'assistant', content: 'listo' } }] },
    ]
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(responses.shift()), { status: 200 })
    }))
    await runWithTools(endpoint, [], [broken], () => {})
    const secondCall = sent[1] as { messages: Array<{ role: string; content: string }> }
    expect(secondCall.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('sin conexión') })
  })

  it('gives up after too many tool rounds instead of looping forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'get_columns', arguments: '{}' } }] } }],
    }), { status: 200 })))
    await expect(runWithTools(endpoint, [], [columns], () => {})).rejects.toThrow(/tool/i)
  })
})
