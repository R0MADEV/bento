// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { note, makeFilterInput, makeCsvBtn, makeResultWrap, buildWheres, rowEl, appendExpandable } from '../../../src/panels/db/dbWidgets'

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  vi.useRealTimers()
})

describe('note', () => {
  it('carries the text and the default class', () => {
    const el = note('nothing here')
    expect(el.textContent).toBe('nothing here')
    expect(el.className).toBe('db-note')
  })

  it('takes an override class', () => {
    expect(note('boom', 'db-detail-error').className).toBe('db-detail-error')
  })
})

describe('makeFilterInput', () => {
  it('debounces and reports the query lowercased', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const input = makeFilterInput(onChange)
    input.value = 'AbC'
    input.dispatchEvent(new Event('input'))
    input.value = 'AbCd'
    input.dispatchEvent(new Event('input'))
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('abcd')
  })
})

describe('makeCsvBtn', () => {
  it('quotes every field and doubles embedded quotes', () => {
    let csv = ''
    vi.stubGlobal('URL', {
      createObjectURL: (b: { text: () => Promise<string> }) => { void b; return 'blob:x' },
      revokeObjectURL: () => {},
    })
    vi.stubGlobal('Blob', class {
      constructor(parts: string[]) { csv = parts.join('') }
    })

    const btn = makeCsvBtn(() => ({ cols: ['a', 'b'], rows: [['1', 'say "hi"']], filename: 'out.csv' }))
    btn.click()
    expect(csv).toBe('"a","b"\n"1","say ""hi"""')
  })
})

describe('makeResultWrap', () => {
  it('puts the toolbar above the table', () => {
    const tbl = document.createElement('table')
    const wrap = makeResultWrap(tbl, [document.createElement('span')])
    expect(wrap.className).toBe('db-result-wrap')
    expect(wrap.children[0].className).toBe('db-result-toolbar')
    expect(wrap.children[1]).toBe(tbl)
  })
})

describe('buildWheres', () => {
  it('pairs each primary-key column with its value in the row', () => {
    expect(buildWheres([0, 2], ['id', 'name', 'tenant'], ['7', 'ana', 'acme']))
      .toEqual([['id', '7'], ['tenant', 'acme']])
  })

  it('is empty for a table with no primary key', () => {
    expect(buildWheres([], ['a'], ['1'])).toEqual([])
  })
})

describe('rowEl', () => {
  it('indents by depth and shows the label', () => {
    const row = rowEl(2, 'table', 'orders', false)
    expect(row.style.paddingLeft).toBe('36px')
    expect(row.querySelector('.db-row-label')!.textContent).toBe('orders')
  })

  it('only gets a chevron when it is expandable', () => {
    expect(rowEl(0, 'database', 'app', true).querySelector('.db-chevron')).not.toBeNull()
    expect(rowEl(0, 'database', 'app', false).querySelector('.db-chevron')).toBeNull()
  })
})

describe('appendExpandable', () => {
  it('loads the children only on the first expand', () => {
    const parent = document.createElement('div')
    const row = rowEl(0, 'database', 'app', true)
    const onFirstExpand = vi.fn()
    appendExpandable(parent, row, onFirstExpand)
    expect(parent.contains(row)).toBe(true)
    expect(onFirstExpand).not.toHaveBeenCalled()

    row.click()
    expect(onFirstExpand).toHaveBeenCalledTimes(1)
    expect(row.classList.contains('open')).toBe(true)

    row.click()
    row.click()
    expect(onFirstExpand).toHaveBeenCalledTimes(1)
  })

  it('collapses and re-expands the same children container', () => {
    const parent = document.createElement('div')
    const row = rowEl(0, 'database', 'app', true)
    appendExpandable(parent, row, children => { children.textContent = 'loaded' })
    row.click()
    const children = parent.querySelector('.db-children') as HTMLElement
    expect(children.textContent).toBe('loaded')

    row.click()
    expect(children.classList.contains('hidden')).toBe(true)
    expect(row.classList.contains('open')).toBe(false)

    row.click()
    expect(children.classList.contains('hidden')).toBe(false)
    expect(row.classList.contains('open')).toBe(true)
  })
})
