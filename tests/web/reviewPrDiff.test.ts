// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SOURCES = [
  'daemon/bento-daemon/src/remote/web/review.js',
  'daemon/bento-daemon/src/remote/web/review-run.js',
  'daemon/bento-daemon/src/remote/web/review-pr.js',
].map(f => readFileSync(f, 'utf8'))

interface Client {
  paintPRDiff: (text: string) => void
  prLineComments: Array<{ path: string, line: number, body: string, user?: { login: string } }>
  prThreads: unknown[]
  splitView: boolean
  q: string
}

function load(): Client {
  const client = globalThis as unknown as Client
  client.q = '?token=t'
  vi.stubGlobal('esc', (text: string) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;'))
  vi.stubGlobal('cwd', () => '/repo')
  for (const source of SOURCES) (0, eval)(source.replace(/^(let|const) /gm, 'var '))
  return client
}

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1,2 +1,2 @@', ' const sin = 1', '-viejo', '+nuevo'].join('\n')

describe('el diff de un PR en el móvil', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="rv-pr-diff-content"></div>' })

  it('deja comentar la línea nueva en una columna', () => {
    const client = load()
    client.splitView = false
    client.prLineComments = []
    client.paintPRDiff(DIFF)
    expect(document.querySelectorAll('.dl-commentable').length).toBeGreaterThan(0)
  })

  it('sigue dejando comentarla en dos columnas', () => {
    const client = load()
    client.splitView = true
    client.prLineComments = []
    client.paintPRDiff(DIFF)
    const cell = document.querySelector<HTMLElement>('.split-add.dl-commentable')
    expect(cell?.dataset.line).toBe('2')
  })

  it('pone los comentarios de una línea bajo ella en las dos vistas', () => {
    const client = load()
    client.prLineComments = [{ path: 'src/a.ts', line: 2, body: 'esto sobra', user: { login: 'yo' } }]
    for (const split of [false, true]) {
      document.body.innerHTML = '<div id="rv-pr-diff-content"></div>'
      client.splitView = split
      client.paintPRDiff(DIFF)
      expect(document.body.textContent, `split=${split}`).toContain('esto sobra')
    }
  })
})
