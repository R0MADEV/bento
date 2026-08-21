import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, httpBackend, setBackend, tauriBackend } from '../../src/core/transport'

afterEach(() => {
  setBackend(null)
  vi.restoreAllMocks()
})

describe('tauriBackend', () => {
  it('delegates to the provided invoke function', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    setBackend(tauriBackend(invoke))

    const result = await call('my_command', { foo: 'bar' })

    expect(invoke).toHaveBeenCalledWith('my_command', { foo: 'bar' })
    expect(result).toEqual({ ok: true })
  })

  it('propagates errors from invoke', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('tauri error'))
    setBackend(tauriBackend(invoke))

    await expect(call('my_command')).rejects.toThrow('tauri error')
  })
})

describe('httpBackend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('POSTs to /api/<cmd> with JSON body and token', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ running: true }), { status: 200 }),
    )
    setBackend(httpBackend('http://localhost:7879', 'mytoken'))

    await call('remote_status', { port: 7879 })

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:7879/api/remote_status?token=mytoken',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 7879 }),
      }),
    )
  })

  it('returns parsed JSON on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ url: 'http://1.2.3.4:7879' }), { status: 200 }),
    )
    setBackend(httpBackend('http://localhost:7879', 'tok'))

    const result = await call<{ url: string }>('remote_start')
    expect(result).toEqual({ url: 'http://1.2.3.4:7879' })
  })

  it('throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }))
    setBackend(httpBackend('http://localhost:7879', 'bad'))

    await expect(call('remote_status')).rejects.toThrow('unauthorized')
  })

  it('omits body when args is undefined', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    setBackend(httpBackend('http://localhost:7879', 'tok'))

    await call('remote_stop')

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: undefined }),
    )
  })
})

describe('call without backend', () => {
  it('throws when no backend is configured', async () => {
    await expect(call('any_command')).rejects.toThrow('transport not initialized')
  })
})
