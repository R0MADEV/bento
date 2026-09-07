// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Los dos scripts que el daemon sirve al móvil, cargados como los carga el
// navegador: la lista de ficheros vive en uno y el pintado del diff en otro.
const SOURCES = [
  'daemon/bento-daemon/src/remote/web/review.js',
  'daemon/bento-daemon/src/remote/web/review-run.js',
].map(f => readFileSync(f, 'utf8'))

interface Client {
  groupedFiles: (files: Array<{ path: string }>) => Array<{ dir?: string, file?: { path: string } }>
  renderDiffSplit: (text: string, path: string) => string
  fileTree: boolean
  reviewFiles: Array<{ path: string, status?: string }>
  reviewViewed: string[]
  renderFiles: () => void
  toggleFileTree: () => void
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

describe('la lista de ficheros del móvil', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('agrupa por carpeta como hace el cli', () => {
    const rows = load().groupedFiles([{ path: 'src/a.ts' }, { path: 'README.md' }, { path: 'src/b.ts' }])
    expect(rows.map(r => r.dir ?? r.file?.path)).toEqual(['README.md', 'src', 'src/a.ts', 'src/b.ts'])
  })

  it('no pone cabecera a lo que está en la raíz', () => {
    const rows = load().groupedFiles([{ path: 'README.md' }])
    expect(rows.filter(r => r.dir !== undefined)).toHaveLength(0)
  })

  it('en árbol enseña el nombre del fichero sin repetir su carpeta', () => {
    const client = load()
    document.body.innerHTML = `
      <input id="rv-files-base" value="main">
      <div id="rv-files-filter"></div>
      <span id="rv-files-count"></span>
      <div id="rv-files-list"></div>`
    client.reviewFiles = [{ path: 'src/panels/a.ts', status: 'M' }]
    client.reviewViewed = []
    client.fileTree = true
    client.renderFiles()

    const list = document.getElementById('rv-files-list')!
    expect(list.querySelector('.file-dir')?.textContent).toBe('src/panels')
    expect(list.querySelector('.file-path')?.textContent).toBe('a.ts')
  })
})

describe('el diff en dos columnas del móvil', () => {
  const DIFF = ['@@ -1,3 +1,3 @@', ' const sin = 1', '-const viejo = 2', '+const nuevo = 2'].join('\n')

  it('deja lo borrado a la izquierda y lo añadido a la derecha, emparejados', () => {
    document.body.innerHTML = `<div id="x">${load().renderDiffSplit(DIFF, 'a.ts')}</div>`
    const rows = document.querySelectorAll('.split-row')
    expect(rows).toHaveLength(2)
    expect(rows[1].querySelector('.split-del')?.textContent).toContain('const viejo = 2')
    expect(rows[1].querySelector('.split-add')?.textContent).toContain('const nuevo = 2')
  })

  it('deja el hueco vacío cuando sólo se añadió', () => {
    document.body.innerHTML = `<div id="x">${load().renderDiffSplit('@@ -1,0 +1,1 @@\n+uno', 'a.ts')}</div>`
    expect(document.querySelectorAll('.split-empty')).toHaveLength(1)
  })

  it('deja en el lado nuevo el fichero y la línea, que es lo que hace falta para comentar', () => {
    document.body.innerHTML = `<div id="x">${load().renderDiffSplit(DIFF, 'src/a.ts')}</div>`
    const cell = document.querySelector<HTMLElement>('.split-add')!
    expect(cell.dataset.file).toBe('src/a.ts')
    expect(cell.dataset.line).toBe('2')
  })

  it('numera cada lado con la línea de su fichero', () => {
    document.body.innerHTML = `<div id="x">${load().renderDiffSplit(DIFF, 'a.ts')}</div>`
    const right = document.querySelectorAll('.split-row')[0].querySelector('.split-add, .split-ctx-right')
    expect(right?.textContent).toContain('1')
  })
})
