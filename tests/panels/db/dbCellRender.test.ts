// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { prettyJson, buildJsonTree, highlightJson, renderCellValue } from '../../../src/panels/db/dbCellRender'

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
})

const td = (): HTMLTableCellElement => document.createElement('td')

describe('prettyJson', () => {
  it('re-indents valid JSON', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  it('returns the input untouched when it is not JSON', () => {
    expect(prettyJson('not json')).toBe('not json')
  })
})

describe('buildJsonTree', () => {
  it('renders a primitive as a single span classed by type', () => {
    expect(buildJsonTree('hi', 0).className).toBe('js')
    expect(buildJsonTree(7, 0).className).toBe('jn')
    expect(buildJsonTree(null, 0).className).toBe('jl')
    expect(buildJsonTree(true, 0).className).toBe('jl')
  })

  it('shows object keys and nests children', () => {
    const el = buildJsonTree({ a: { b: 1 } }, 0)
    expect(el.querySelectorAll('.jk')[0].textContent).toBe('"a"')
    expect(el.textContent).toContain('1')
  })

  it('labels arrays with brackets and omits index keys', () => {
    const el = buildJsonTree([1, 2], 0)
    expect(el.querySelector('.jp')!.textContent).toBe('[')
    expect(el.querySelector('.jk')).toBeNull()
  })

  it('opens the first two levels and keeps deeper ones collapsed', () => {
    const open = buildJsonTree({ a: 1 }, 1)
    expect((open.querySelector('.jt-body') as HTMLElement).style.display).toBe('block')
    const collapsed = buildJsonTree({ a: 1 }, 2)
    expect((collapsed.querySelector('.jt-body') as HTMLElement).style.display).toBe('none')
  })

  it('stops recursing past depth 6 and shows a size hint instead', () => {
    const el = buildJsonTree([1, 2, 3], 6)
    expect(el.className).toBe('jt-hint')
    expect(el.textContent).toBe('[…3]')
  })

  it('toggles a node open and closed on click', () => {
    const el = buildJsonTree({ a: 1 }, 0)
    const body = el.querySelector('.jt-body') as HTMLElement
    const toggle = el.querySelector('.jt-toggle') as HTMLButtonElement
    toggle.click()
    expect(body.style.display).toBe('none')
    expect(toggle.textContent).toBe('▶')
    toggle.click()
    expect(body.style.display).toBe('block')
    expect(toggle.textContent).toBe('▼')
  })
})

describe('highlightJson', () => {
  it('classes keys, strings, numbers, literals and punctuation apart', () => {
    const pre = document.createElement('pre')
    highlightJson(pre, '{"k": "v", "n": 1, "b": null}')
    const cls = (c: string) => [...pre.querySelectorAll(c)].map(e => e.textContent)
    expect(cls('.jk')).toEqual(['"k"', '"n"', '"b"'])
    expect(cls('.js')).toEqual(['"v"'])
    expect(cls('.jn')).toEqual(['1'])
    expect(cls('.jl')).toEqual(['null'])
    expect(cls('.jp')).toEqual(['{', ',', ',', '}'])
  })

  it('replaces previous content instead of appending on a second call', () => {
    const pre = document.createElement('pre')
    highlightJson(pre, '{"a": 1}')
    highlightJson(pre, '{"b": 2}')
    expect(pre.textContent).toBe('{"b": 2}')
  })
})

describe('renderCellValue', () => {
  it('writes a short scalar as plain text with no expander', () => {
    const cell = td()
    renderCellValue(cell, 'hello')
    expect(cell.textContent).toBe('hello')
    expect(cell.querySelector('.db-json-cell')).toBeNull()
  })

  it('marks NULL cells and clears the mark when the value changes', () => {
    const cell = td()
    renderCellValue(cell, 'NULL')
    expect(cell.classList.contains('db-null')).toBe(true)
    renderCellValue(cell, 'x')
    expect(cell.classList.contains('db-null')).toBe(false)
  })

  it('gives long or multiline text an expandable preview of the first line', () => {
    const cell = td()
    renderCellValue(cell, 'first line\nsecond line')
    expect(cell.classList.contains('db-json-td')).toBe(true)
    expect(cell.querySelector('.db-text-preview')!.textContent).toBe('first line')
  })

  it('summarises JSON objects by key count and arrays by item count', () => {
    const obj = td()
    renderCellValue(obj, '{"a":1,"b":2}')
    expect(obj.querySelector('.db-json-badge')).not.toBeNull()
    expect(obj.querySelector('.db-json-preview')!.textContent).toContain('2')

    const arr = td()
    renderCellValue(arr, '[1,2,3]')
    expect(arr.querySelector('.db-json-preview')!.textContent).toContain('3')
  })

  it('renders parsed JSON as a tree and truncated JSON as raw text', () => {
    const full = td()
    renderCellValue(full, '{"a":1}')
    expect(full.querySelector('.db-json-content .jt-node')).not.toBeNull()

    const cut = td()
    renderCellValue(cut, '{"a":1,…')
    expect(cut.querySelector('.db-json-content')!.tagName).toBe('PRE')
  })

  it('opens the panel on click and closes it on Escape', () => {
    const cell = td()
    document.body.appendChild(cell)
    renderCellValue(cell, '{"a":1}')
    const wrap = cell.querySelector('.db-json-cell')!
    ;(cell.querySelector('.db-json-summary') as HTMLElement).click()
    expect(wrap.classList.contains('db-json-open')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrap.classList.contains('db-json-open')).toBe(false)
  })

  it('closes the previously open cell when another one opens', () => {
    const a = td(), b = td()
    document.body.append(a, b)
    renderCellValue(a, '{"a":1}')
    renderCellValue(b, '{"b":2}')
    ;(a.querySelector('.db-json-summary') as HTMLElement).click()
    ;(b.querySelector('.db-json-summary') as HTMLElement).click()
    expect(a.querySelector('.db-json-cell')!.classList.contains('db-json-open')).toBe(false)
    expect(b.querySelector('.db-json-cell')!.classList.contains('db-json-open')).toBe(true)
  })

  it('copies the raw value, not the rendered tree', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const cell = td()
    renderCellValue(cell, '{"a":1}')
    ;(cell.querySelector('.db-json-copy') as HTMLButtonElement).click()
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}')
  })
})
