// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The phone client is a plain script the daemon serves, not a module: it is
// loaded here the way the browser loads it, so its own functions are what the
// tests call. Nothing in it runs at load time.
const source = readFileSync('daemon/bento-daemon/src/remote/web/review.js', 'utf8')

interface ReviewClient {
  fmtRelDate: (iso: string) => string
  saveReviewCheckpoint: (dir: string, base: string, buf: string) => Promise<void>
  restoreReviewCheckpoint: (dir: string, base: string, runId?: string) => Promise<void>
  reviewRunId: string | null
  reviewSessionId: string | null
  q: string
}

function load(): ReviewClient {
  const client = globalThis as unknown as ReviewClient
  // The page the daemon renders defines these around the script: the token
  // query string, the chat panel the sibling files own, and the escaper the
  // shared one exports.
  client.q = '?token=t'
  vi.stubGlobal('showChat', vi.fn())
  vi.stubGlobal('hideChat', vi.fn())
  vi.stubGlobal('esc', (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  // Its top-level state is `let`, which in the browser is exactly what the
  // sibling scripts write to. Reached from a test only as `var`, because a
  // lexical global is not a property of `globalThis`.
  ;(0, eval)(source.replace(/^(let|const) /gm, 'var '))
  return client
}

function fetchSpy(response?: Partial<Response>) {
  const spy = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}), ...response } as Response))
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('el cliente de review del móvil', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('cuenta cuánto hace que se guardó una review', () => {
    const client = load()
    const minutesAgo = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString()

    expect(client.fmtRelDate(minutesAgo(0))).toBe('ahora')
    expect(client.fmtRelDate(minutesAgo(5))).toBe('5m')
    expect(client.fmtRelDate(minutesAgo(120))).toBe('2h')
    expect(client.fmtRelDate(minutesAgo(60 * 24 * 3))).toBe('3d')
  })

  it('no guarda una review vacía', async () => {
    const client = load()
    const fetched = fetchSpy()

    await client.saveReviewCheckpoint('/repo', 'main', '   \n ')

    // Guardarla dejaría al historial una entrada en blanco por delante de la
    // review de verdad de esa rama.
    expect(fetched).not.toHaveBeenCalled()
  })

  it('manda el run al guardar, que es lo que separa dos reviews de la misma rama', async () => {
    const client = load()
    const fetched = fetchSpy()
    client.reviewRunId = 'run-7'
    client.reviewSessionId = 'sess-7'

    await client.saveReviewCheckpoint('/repo', 'main', 'informe')

    const [url, init] = fetched.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/review/checkpoint?token=t')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toMatchObject({
      cwd: '/repo', base: 'main', content: 'informe', run_id: 'run-7', session_id: 'sess-7',
    })
  })

  it('pide la review que nombras, no la última de la rama', async () => {
    const client = load()
    const fetched = fetchSpy({ json: () => Promise.resolve({ content: '# informe' }) })
    document.body.innerHTML = '<div id="rv-output"></div>'

    await client.restoreReviewCheckpoint('/repo', 'main', 'run-3')

    expect(String(fetched.mock.calls[0]?.[0])).toContain('run_id=run-3')
    expect(document.getElementById('rv-output')?.innerHTML).toContain('informe')
  })

  it('sin review guardada deja el hueco explicado en vez de en blanco', async () => {
    const client = load()
    fetchSpy({ ok: false })
    document.body.innerHTML = '<div id="rv-output">lo de antes</div>'

    await client.restoreReviewCheckpoint('/repo', 'main')

    expect(document.getElementById('rv-output')?.textContent).toContain('Elige un proyecto')
  })
})

// review-run.js fills the agent selects as it loads, so its DOM has to exist
// first — the same order the page uses.
const runSource = readFileSync('daemon/bento-daemon/src/remote/web/review-run.js', 'utf8')

interface ReviewRunClient {
  selectedAgents: () => string[]
  BENTO_AGENTS: { id: string, label: string }[]
}

function loadRun(): ReviewRunClient {
  const client = globalThis as unknown as ReviewRunClient
  document.body.innerHTML = `
    <select id="rv-agent"></select>
    <input id="rv-compare-toggle" type="checkbox">
    <select id="rv-agent-secondary"><option value=""></option></select>
    <select id="rv-agent-tertiary"><option value=""></option></select>`
  // Served by the daemon at /agents.js, generated from `bento_review::agents`.
  client.BENTO_AGENTS = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }]
  ;(0, eval)(runSource.replace(/^(let|const) /gm, 'var '))
  return client
}

describe('los agentes que corre el móvil', () => {
  it('con comparar apagado corre solo el primario', () => {
    const client = loadRun()
    ;(document.getElementById('rv-agent') as HTMLSelectElement).value = 'codex'

    expect(client.selectedAgents()).toEqual(['codex'])
  })

  it('con comparar encendido añade las pasadas extra que son agentes de verdad', () => {
    const client = loadRun()
    ;(document.getElementById('rv-compare-toggle') as HTMLInputElement).checked = true
    ;(document.getElementById('rv-agent-secondary') as HTMLSelectElement).value = 'codex'

    // La terciaria se queda en "" — sin filtrarla se pediría una review a un
    // agente que no existe.
    expect(client.selectedAgents()).toEqual(['claude', 'codex'])
  })
})

describe('el documento que manda el motor', () => {
  it('reconoce la línea del documento y se queda con el markdown', () => {
    const client = loadRun() as unknown as { reviewDocumentFrom: (data: unknown) => string | null }

    expect(client.reviewDocumentFrom('[DOCUMENT]\n## Revisión: feat/x\nBase: `main`'))
      .toBe('## Revisión: feat/x\nBase: `main`')
  })

  it('no confunde con el documento un informe que lo menciona', () => {
    const client = loadRun() as unknown as { reviewDocumentFrom: (data: unknown) => string | null }

    expect(client.reviewDocumentFrom('mira el [DOCUMENT] ese')).toBeNull()
    expect(client.reviewDocumentFrom({ nope: true })).toBeNull()
  })
})
