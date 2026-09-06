import { reviewT } from './i18n'
import { esc, highlightCode, wordDiff } from './reviewFormat'

// Pintar el diff de un archivo, en línea o a dos columnas. Lo que cambia entre
// los dos modos es solo cómo se colocan las líneas: el resto (anclas para
// comentar, selección por rango) es igual, y por eso reciben los mismos
// ganchos desde el panel.

export interface FileDiffDeps {
  makeLineForm: (filePath: string, line: number, startLine?: number) => HTMLElement
  createLineRangeSelector: (container: HTMLElement, filePath: string, getInsertTarget: (anchorWrap: HTMLElement) => Element) => { start: (line: number) => void }
}

export function buildFileDiffRenderers(deps: FileDiffDeps): {
  buildFileDiff: (chunk: string, filePath: string) => HTMLElement
  buildFileDiffSideBySide: (chunk: string, filePath: string) => HTMLElement
} {
  const { createLineRangeSelector } = deps
  const buildFileDiff = (chunk: string, filePath: string): HTMLElement => {
    const container = document.createElement('div')
    container.dataset.filepath = filePath
    const ext = filePath.split('.').pop() ?? ''
    const rangeSelector = createLineRangeSelector(container, filePath, anchorWrap => anchorWrap)

    // Parse diff into typed entries for two-pass rendering with word diff
    type UEntry =
      | { kind: 'hunk'; raw: string }
      | { kind: 'meta' }
      | { kind: 'add'; lineNo: number; code: string }
      | { kind: 'del'; code: string }
      | { kind: 'ctx'; lineNo: number; code: string }

    const entries: UEntry[] = []
    let newLine = 0
    for (const raw of chunk.split('\n')) {
      const isAdd = raw.startsWith('+') && !raw.startsWith('+++')
      const isDel = raw.startsWith('-') && !raw.startsWith('---')
      const isHunk = raw.startsWith('@@')
      const isMeta = raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')
      if (isHunk) {
        const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
        if (m) newLine = parseInt(m[1], 10) - 1
        entries.push({ kind: 'hunk', raw })
      } else if (isMeta) {
        entries.push({ kind: 'meta' })
      } else if (isDel) {
        entries.push({ kind: 'del', code: raw.slice(1) })
      } else if (isAdd) {
        entries.push({ kind: 'add', lineNo: ++newLine, code: raw.slice(1) })
      } else {
        entries.push({ kind: 'ctx', lineNo: ++newLine, code: raw.slice(1) })
      }
    }

    // El HTML de todas las líneas se junta y se asigna de una vez al final:
    // cada línea hacía su propio `innerHTML`, o sea dos mil parseos de HTML
    // para abrir un fichero, y el tirón se nota al desplegarlo.
    const html: string[] = []
    const mkWrap = (lineNo: number | null, prefix: string, codeHtml: string, extraCls: string): void => {
      const line = lineNo === null ? '' : ` data-line="${lineNo}"`
      const button = lineNo === null
        ? ''
        : `<button class="review-line-comment-btn" title="${esc(reviewT('commentLine', { line: lineNo }))}">+</button>`
      html.push(
        `<div class="review-diff-line-wrap"${line}>`
        + `<div class="tasks-diff-code-line${extraCls ? ' ' + extraCls : ''}">${button}`
        + `<span><span class="tasks-diff-line-no">${lineNo ?? ''}</span>${esc(prefix)}${codeHtml}</span>`
        + '</div></div>',
      )
    }

    let i = 0
    while (i < entries.length) {
      const e = entries[i]
      if (e.kind === 'meta') { i++; continue }
      if (e.kind === 'hunk') {
        html.push(
          '<div class="review-diff-line-wrap"><div class="tasks-diff-code-line tasks-diff-hunk">'
          + `<span><span class="tasks-diff-line-no"></span>${esc(e.raw)}</span></div></div>`,
        )
        i++; continue
      }
      if (e.kind === 'ctx') {
        mkWrap(e.lineNo, ' ', highlightCode(e.code, ext), '')
        i++; continue
      }
      // Collect consecutive del then add block, apply word diff for paired lines
      const dels: string[] = []
      while (i < entries.length && entries[i].kind === 'del') { dels.push((entries[i] as { kind: 'del'; code: string }).code); i++ }
      const adds: { lineNo: number; code: string }[] = []
      while (i < entries.length && entries[i].kind === 'add') { adds.push(entries[i] as { kind: 'add'; lineNo: number; code: string }); i++ }
      for (let j = 0; j < dels.length; j++) {
        const lineHtml = (adds[j] !== undefined) ? wordDiff(dels[j], adds[j].code).oldHtml : highlightCode(dels[j], ext)
        mkWrap(null, '-', lineHtml, 'tasks-diff-line-del')
      }
      for (let j = 0; j < adds.length; j++) {
        const lineHtml = (dels[j] !== undefined) ? wordDiff(dels[j], adds[j].code).newHtml : highlightCode(adds[j].code, ext)
        mkWrap(adds[j].lineNo, '+', lineHtml, 'tasks-diff-line-add')
      }
    }
    container.innerHTML = html.join('')
    // El botón de comentar, por delegación: dos mil escuchas era una por
    // línea, y con el bloque armado de golpe ya no hay dónde colgarlas.
    container.addEventListener('mousedown', event => {
      const target = event.target as HTMLElement
      if (!target.classList.contains('review-line-comment-btn')) return
      const line = Number(target.closest<HTMLElement>('[data-line]')?.dataset.line)
      if (!Number.isFinite(line)) return
      event.preventDefault()
      rangeSelector.start(line)
    })
    return container
  }

  // ── Side-by-side diff renderer ────────────────────────────────────────────

  const buildFileDiffSideBySide = (chunk: string, filePath: string): HTMLElement => {
    const container = document.createElement('div')
    container.className = 'review-split-diff'
    container.dataset.filepath = filePath
    const ext = filePath.split('.').pop() ?? ''

    type DiffEntry =
      | { kind: 'hunk'; text: string }
      | { kind: 'meta' }
      | { kind: 'context'; oldNo: number; newNo: number; text: string }
      | { kind: 'del'; oldNo: number; text: string }
      | { kind: 'add'; newNo: number; text: string }

    const entries: DiffEntry[] = []
    let oldLine = 0, newLine = 0

    for (const raw of chunk.split('\n')) {
      const isAdd = raw.startsWith('+') && !raw.startsWith('+++')
      const isDel = raw.startsWith('-') && !raw.startsWith('---')
      const isHunk = raw.startsWith('@@')
      const isMeta = raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')
      if (isHunk) {
        const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
        if (m) { oldLine = parseInt(m[1]) - 1; newLine = parseInt(m[2]) - 1 }
        entries.push({ kind: 'hunk', text: raw })
      } else if (isMeta) {
        entries.push({ kind: 'meta' })
      } else if (isDel) {
        entries.push({ kind: 'del', oldNo: ++oldLine, text: raw.slice(1) })
      } else if (isAdd) {
        entries.push({ kind: 'add', newNo: ++newLine, text: raw.slice(1) })
      } else {
        entries.push({ kind: 'context', oldNo: ++oldLine, newNo: ++newLine, text: raw })
      }
    }

    // Drag-to-select (right side only)
    const rangeSelector = createLineRangeSelector(
      container, filePath,
      (anchorWrap: HTMLElement) => anchorWrap.closest('.review-split-row') ?? anchorWrap,
    )

    const mkRightCell = (lineNo: number, text: string, extraCls: string, preHtml?: string): HTMLElement => {
      const cell = document.createElement('div')
      cell.className = `review-split-cell review-split-cell--right ${extraCls}`
      cell.dataset.line = String(lineNo)
      const addBtn = Object.assign(document.createElement('button'), {
        className: 'review-line-comment-btn', textContent: '+', title: reviewT('commentLine', { line: lineNo }),
      })
      const cap = lineNo
      addBtn.addEventListener('mousedown', e => {
        e.preventDefault(); rangeSelector.start(cap)
      })
      cell.innerHTML = `<span class="tasks-diff-line-no">${lineNo}</span>${preHtml ?? highlightCode(text, ext)}`
      cell.prepend(addBtn)
      return cell
    }

    let i = 0
    while (i < entries.length) {
      const entry = entries[i]
      if (entry.kind === 'meta') { i++; continue }
      if (entry.kind === 'hunk') {
        const hunkEl = Object.assign(document.createElement('div'), { className: 'review-split-hunk', textContent: entry.text })
        container.append(hunkEl); i++; continue
      }
      if (entry.kind === 'context') {
        const row = document.createElement('div')
        row.className = 'review-split-row'
        const left = document.createElement('div')
        left.className = 'review-split-cell review-split-cell--left'
        left.innerHTML = `<span class="tasks-diff-line-no">${entry.oldNo}</span>${highlightCode(entry.text, ext)}`
        row.append(left, mkRightCell(entry.newNo, entry.text, ''))
        container.append(row); i++; continue
      }
      // del/add block: collect and pair
      const dels: Array<{ kind: 'del'; oldNo: number; text: string }> = []
      const adds: Array<{ kind: 'add'; newNo: number; text: string }> = []
      while (i < entries.length && entries[i].kind === 'del') {
        dels.push(entries[i] as { kind: 'del'; oldNo: number; text: string }); i++
      }
      while (i < entries.length && entries[i].kind === 'add') {
        adds.push(entries[i] as { kind: 'add'; newNo: number; text: string }); i++
      }
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        const del = dels[j], add = adds[j]
        const wdiff = (del && add) ? wordDiff(del.text, add.text) : null
        const row = document.createElement('div')
        row.className = 'review-split-row'
        const left = document.createElement('div')
        if (del) {
          left.className = 'review-split-cell review-split-cell--left review-split-cell--del'
          left.innerHTML = `<span class="tasks-diff-line-no">${del.oldNo}</span>${wdiff ? wdiff.oldHtml : highlightCode(del.text, ext)}`
        } else {
          left.className = 'review-split-cell review-split-cell--left review-split-cell--empty'
        }
        const right = add
          ? mkRightCell(add.newNo, add.text, 'review-split-cell--add', wdiff?.newHtml)
          : Object.assign(document.createElement('div'), { className: 'review-split-cell review-split-cell--right review-split-cell--empty' })
        row.append(left, right)
        container.append(row)
      }
    }
    return container
  }

  // ── Build a file <details> element ────────────────────────────────────────

  return { buildFileDiff, buildFileDiffSideBySide }
}
