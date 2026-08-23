import { t as i18nT } from '../../i18n'
import { parseStructuredJson } from './jsonValues'

// Only one expanded JSON/text panel at a time: opening one closes the previous.
let closeOpenPanel: (() => void) | null = null

export const prettyJson = (json: string): string => {
  try { return JSON.stringify(JSON.parse(json), null, 2) } catch { return json }
}

const mkSpan = (cls: string, text: string): HTMLSpanElement => {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  return s
}

// Matches: key+colon | string value | number | true/false/null | punctuation
const JSON_TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g

const primitiveClass = (val: unknown): string => {
  if (typeof val === 'string') return 'js'
  if (typeof val === 'number') return 'jn'
  return 'jl'
}

export const buildJsonTree = (val: unknown, depth: number): HTMLElement => {
  if (val === null || typeof val !== 'object') {
    return mkSpan(primitiveClass(val), JSON.stringify(val))
  }
  const isArr = Array.isArray(val)
  const entries: [string, unknown][] = isArr
    ? (val as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(val as Record<string, unknown>)
  const openB = isArr ? '[' : '{'
  const closeB = isArr ? ']' : '}'
  if (depth >= 6) return mkSpan('jt-hint', `${openB}…${entries.length}${closeB}`)
  const initialOpen = depth < 2

  const node = document.createElement('div')
  node.className = 'jt-node'

  const header = document.createElement('span')
  header.className = 'jt-header'
  const toggle = document.createElement('button')
  toggle.className = 'jt-toggle'
  toggle.textContent = initialOpen ? '▼' : '▶'
  const hint = document.createElement('span')
  hint.className = 'jt-hint'
  hint.textContent = `${entries.length}${closeB}`
  hint.style.display = initialOpen ? 'none' : 'inline'
  header.append(toggle, mkSpan('jp', openB), hint)

  const body = document.createElement('div')
  body.className = 'jt-body'
  body.style.display = initialOpen ? 'block' : 'none'
  entries.forEach(([key, childVal]) => {
    const row = document.createElement('div')
    row.className = 'jt-row'
    if (!isArr) {
      row.appendChild(mkSpan('jk', `"${key}"`))
      row.appendChild(document.createTextNode(': '))
    }
    row.appendChild(buildJsonTree(childVal, depth + 1))
    body.appendChild(row)
  })

  const close = document.createElement('span')
  close.className = 'jp jt-close'
  close.textContent = closeB
  close.style.display = initialOpen ? 'block' : 'none'

  toggle.addEventListener('click', e => {
    e.stopPropagation()
    const nowOpen = body.style.display === 'none'
    body.style.display = nowOpen ? 'block' : 'none'
    hint.style.display = nowOpen ? 'none' : 'inline'
    close.style.display = nowOpen ? 'block' : 'none'
    toggle.textContent = nowOpen ? '▼' : '▶'
  })

  node.append(header, body, close)
  return node
}

export const highlightJson = (pre: HTMLPreElement, src: string): void => {
  const frag = document.createDocumentFragment()
  let cursor = 0
  let m: RegExpExecArray | null
  JSON_TOKEN_RE.lastIndex = 0
  while ((m = JSON_TOKEN_RE.exec(src)) !== null) {
    if (m.index > cursor) frag.appendChild(document.createTextNode(src.slice(cursor, m.index)))
    if (m[1] !== undefined) {
      frag.appendChild(mkSpan('jk', m[1]))
      frag.appendChild(document.createTextNode(m[2] ?? ''))
    } else if (m[3] !== undefined) {
      frag.appendChild(mkSpan('js', m[3]))
    } else if (m[4] !== undefined) {
      frag.appendChild(mkSpan('jn', m[4]))
    } else if (m[5] !== undefined) {
      frag.appendChild(mkSpan('jl', m[5]))
    } else if (m[6] !== undefined) {
      frag.appendChild(mkSpan('jp', m[6]))
    }
    cursor = m.index + m[0].length
  }
  if (cursor < src.length) frag.appendChild(document.createTextNode(src.slice(cursor)))
  pre.replaceChildren(frag)
}

export const renderCellValue = (td: HTMLTableCellElement, value: string): void => {
  td.replaceChildren()
  td.classList.toggle('db-null', value === 'NULL')
  td.classList.remove('db-json-td')

  const json = parseStructuredJson(value)
  const isLongText = !json && (value.includes('\n') || value.length > 40 || value.endsWith('…'))

  if (!json && !isLongText) {
    td.textContent = value
    return
  }

  td.classList.add('db-json-td')
  const cell = document.createElement('div')
  cell.className = 'db-json-cell'
  const summaryEl = document.createElement('div')
  summaryEl.className = 'db-json-summary'

  const closeCell = (): void => {
    cell.classList.remove('db-json-open')
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeyDown)
    closeOpenPanel = null
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (!cell.contains(e.target as Node)) closeCell()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeCell()
  }

  summaryEl.addEventListener('click', () => {
    const nowOpen = cell.classList.toggle('db-json-open')
    if (nowOpen) {
      closeOpenPanel?.()
      closeOpenPanel = closeCell
      document.addEventListener('pointerdown', onPointerDown)
      document.addEventListener('keydown', onKeyDown)
      requestAnimationFrame(() => {
        const rect = panel.getBoundingClientRect()
        panel.classList.toggle('db-json-flip', rect.bottom > window.innerHeight - 8)
      })
    } else {
      closeCell()
    }
  })

  if (json) {
    summaryEl.title = i18nT('db.expandJson')
    const badge = document.createElement('span')
    badge.className = 'db-json-badge'
    badge.textContent = i18nT('db.jsonBadge')
    const preview = document.createElement('span')
    preview.className = 'db-json-preview'
    preview.textContent = json.truncated
      ? i18nT('db.jsonTruncated')
      : json.kind === 'array'
        ? i18nT('db.jsonItems', { count: json.size })
        : i18nT('db.jsonKeys', { count: json.size })
    summaryEl.append(badge, preview)
  } else {
    const textPreview = document.createElement('span')
    textPreview.className = 'db-text-preview'
    textPreview.textContent = value.split('\n')[0].trim()
    summaryEl.appendChild(textPreview)
  }

  const rawContent = json ? json.formatted : value
  let contentEl: HTMLElement
  if (json && !json.truncated) {
    contentEl = document.createElement('div')
    contentEl.className = 'db-json-content'
    contentEl.appendChild(buildJsonTree(JSON.parse(json.formatted), 0))
  } else {
    contentEl = document.createElement('pre')
    contentEl.className = 'db-json-content'
    contentEl.textContent = rawContent
  }
  contentEl.addEventListener('dblclick', event => event.stopPropagation())

  const copyBtn = document.createElement('button')
  copyBtn.className = 'db-json-copy'
  copyBtn.title = i18nT('db.jsonCopy')
  copyBtn.textContent = '⎘'
  copyBtn.addEventListener('click', e => {
    e.stopPropagation()
    void navigator.clipboard.writeText(rawContent).then(() => {
      copyBtn.textContent = '✓'
      setTimeout(() => { copyBtn.textContent = '⎘' }, 1200)
    })
  })

  const panel = document.createElement('div')
  panel.className = 'db-json-panel'
  panel.append(copyBtn, contentEl)
  cell.append(summaryEl, panel)
  td.appendChild(cell)
}
