type Invoker = (cmd: string, args?: unknown) => Promise<unknown>

export interface Backend {
  call<T>(cmd: string, args?: unknown): Promise<T>
}

let _backend: Backend | null = null

export function setBackend(b: Backend | null): void {
  _backend = b
}

export async function call<T>(cmd: string, args?: unknown): Promise<T> {
  if (!_backend) throw new Error('transport not initialized')
  return _backend.call<T>(cmd, args)
}

export function tauriBackend(invoke: Invoker): Backend {
  return {
    call<T>(cmd: string, args?: unknown): Promise<T> {
      return invoke(cmd, args) as Promise<T>
    },
  }
}

export function httpBackend(baseUrl: string, token: string): Backend {
  return {
    async call<T>(cmd: string, args?: unknown): Promise<T> {
      const r = await fetch(`${baseUrl}/api/${cmd}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: args !== undefined ? JSON.stringify(args) : undefined,
      })
      if (!r.ok) throw new Error(await r.text())
      return r.json() as Promise<T>
    },
  }
}
