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

// Los PRs y el chat de seguimiento del móvil: escriben en GitHub desde el
// teléfono, y hasta ahora no los probaba nadie.
const prSource = readFileSync('daemon/bento-daemon/src/remote/web/review-pr.js', 'utf8')
const askSource = readFileSync('daemon/bento-daemon/src/remote/web/review-ask.js', 'utf8')

interface PrClient {
  submitComment: () => Promise<void>
  submitReview: () => Promise<void>
  switchPRTab: (name: string) => void
  currentPR: number | null
}

function loadPr(): PrClient {
  const client = globalThis as unknown as PrClient
  document.body.innerHTML = `
    <div id="rv-pr-view"></div>
    <textarea id="rv-comment-text"></textarea>
    <button id="rv-comment-submit"></button>
    <textarea id="rv-submit-body"></textarea>
    <button id="rv-submit-btn"></button>
    <input type="radio" name="rv-event" value="APPROVE" checked>
    <select id="rv-project"><option value="/repo" selected>/repo</option></select>
    <div id="rv-pr-tab-diff" class="rv-pr-tab"></div>
    <div id="rv-pr-tab-comments" class="rv-pr-tab"></div>
    <div id="rv-pr-diff"></div>
    <div id="rv-pr-comments"></div>
    <div id="rv-comments-list"></div>`
  ;(globalThis as unknown as { q: string }).q = '?token=t'
  ;(0, eval)(prSource.replace(/^(let|const) /gm, 'var '))
  client.currentPR = 7
  return client
}

describe('los PRs desde el móvil', () => {
  it('no manda un comentario vacío', async () => {
    const client = loadPr()
    const fetched = fetchSpy()

    await client.submitComment()

    expect(fetched).not.toHaveBeenCalled()
  })

  it('manda el comentario al PR abierto y vacía la caja', async () => {
    const client = loadPr()
    const fetched = fetchSpy()
    const textarea = document.getElementById('rv-comment-text') as HTMLTextAreaElement
    textarea.value = '  esto está mal  '

    await client.submitComment()

    const [url, init] = fetched.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/review/pr/comment')
    expect(url).toContain('pr=7')
    expect(JSON.parse(String(init.body))).toEqual({ body: 'esto está mal' })
    expect(textarea.value).toBe('')
  })

  it('deja el botón usable aunque la petición falle', async () => {
    const client = loadPr()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('sin red'))))
    ;(document.getElementById('rv-comment-text') as HTMLTextAreaElement).value = 'algo'
    const btn = document.getElementById('rv-comment-submit') as HTMLButtonElement

    // Un botón que se queda deshabilitado tras un fallo de red deja el panel
    // muerto hasta recargar.
    await expect(client.submitComment()).rejects.toThrow('sin red')
    expect(btn.disabled).toBe(false)
  })

  it('manda la revisión con el veredicto marcado', async () => {
    const client = loadPr()
    const fetched = fetchSpy()
    ;(document.getElementById('rv-submit-body') as HTMLTextAreaElement).value = 'ok por mí'

    await client.submitReview()

    const [, init] = fetched.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ event: 'APPROVE', body: 'ok por mí' })
  })
})

describe('el chat de seguimiento del móvil', () => {
  function loadAsk() {
    document.body.innerHTML = `
      <div id="rv-chat"></div>
      <div id="rv-chat-msgs"><div>lo de antes</div></div>
      <textarea id="rv-ask-input"></textarea>
      <button id="rv-ask-send"></button>`
    ;(0, eval)(askSource.replace(/^(let|const) /gm, 'var '))
    return globalThis as unknown as {
      showChat: () => void
      hideChat: () => void
      sendAsk: () => void
    }
  }

  it('esconder el chat se lleva la conversación de antes', () => {
    const client = loadAsk()

    client.hideChat()

    // Si no, la siguiente review abre con las respuestas de la anterior.
    expect(document.getElementById('rv-chat-msgs')?.innerHTML).toBe('')
    expect((document.getElementById('rv-chat') as HTMLElement).style.display).toBe('none')
  })

  it('no manda una pregunta vacía', () => {
    const client = loadAsk()
    const opened: string[] = []
    vi.stubGlobal('EventSource', class { constructor(url: string) { opened.push(url) } close() {} })
    ;(document.getElementById('rv-ask-input') as HTMLTextAreaElement).value = '   '

    client.sendAsk()

    expect(opened).toEqual([])
  })
})

// El cliente de terminales del móvil. Vive en el mismo daemon y hasta ahora
// solo sabía abrir una shell en casa.
const terminalSource = readFileSync('daemon/bento-daemon/src/remote/web/terminal.js', 'utf8')

interface TerminalClient {
  newTerminalUrl: (cwd: string | null) => string
}

function loadTerminal(): TerminalClient {
  document.body.innerHTML = `
    <div id="page-terminals"></div>
    <div id="list"></div>
    <button id="newbtn"></button>
    <input id="inp">
    <div id="term"></div>
    <div id="dot"></div>`
  ;(globalThis as unknown as { q: string }).q = '?token=t'
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response)))
  ;(0, eval)(terminalSource.replace(/^(let|const) /gm, 'var '))
  return globalThis as unknown as TerminalClient
}

describe('abrir una terminal desde el móvil', () => {
  it('la abre en el proyecto que elijas', () => {
    const client = loadTerminal()

    // Sin decir dónde, el daemon la abre en casa — que para trabajar en un
    // proyecto no vale de nada.
    expect(client.newTerminalUrl('/repo/bento')).toBe('/api/terminals?token=t&cwd=%2Frepo%2Fbento')
  })

  it('y sin proyecto, donde el daemon decida', () => {
    const client = loadTerminal()

    expect(client.newTerminalUrl(null)).toBe('/api/terminals?token=t')
  })
})

describe('buscar en el terminal del móvil', () => {
  it('busca hacia delante y hacia atrás con el mismo addon que el escritorio', () => {
    const client = loadTerminal() as unknown as {
      searchTerminal: (addon: unknown, term: string, backwards: boolean) => void
    }
    const calls: string[] = []
    const addon = {
      findNext: (t: string) => calls.push(`next:${t}`),
      findPrevious: (t: string) => calls.push(`prev:${t}`),
    }

    client.searchTerminal(addon, 'error', false)
    client.searchTerminal(addon, 'error', true)

    expect(calls).toEqual(['next:error', 'prev:error'])
  })

  it('no busca una cadena vacía', () => {
    const client = loadTerminal() as unknown as {
      searchTerminal: (addon: unknown, term: string, backwards: boolean) => void
    }
    const calls: string[] = []
    const addon = { findNext: () => calls.push('x'), findPrevious: () => calls.push('x') }

    client.searchTerminal(addon, '   ', false)

    expect(calls).toEqual([])
  })
})

describe('comentar una línea del PR desde el móvil', () => {
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,4 @@',
    ' contexto',
    '-lo viejo',
    '+lo nuevo',
    ' final',
  ].join('\n')

  function loadPrWithDiff() {
    const client = loadPr() as unknown as {
      diffAnchors: (text: string) => ({ file: string, line: number } | null)[]
    }
    return client
  }

  it('sabe a qué fichero y a qué línea del fichero nuevo apunta cada fila', () => {
    const anchors = loadPrWithDiff().diffAnchors(DIFF)

    expect(anchors[4]).toEqual({ file: 'src/a.ts', line: 10 })
    expect(anchors[6]).toEqual({ file: 'src/a.ts', line: 11 })
    expect(anchors[7]).toEqual({ file: 'src/a.ts', line: 12 })
  })

  it('no deja comentar donde GitHub no ancla nada', () => {
    const anchors = loadPrWithDiff().diffAnchors(DIFF)

    // Una línea borrada ya no está en la versión nueva; las cabeceras no son
    // código.
    expect(anchors[5]).toBeNull()
    expect(anchors[0]).toBeNull()
    expect(anchors[2]).toBeNull()
    expect(anchors[3]).toBeNull()
  })
})
