// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { note, mkBtn, detailHeader, field } from '../../../src/panels/jira/jiraWidgets'

describe('note', () => {
  it('carries the text and the default class', () => {
    const el = note('nothing here')
    expect(el.textContent).toBe('nothing here')
    expect(el.className).toBe('jira-note')
  })

  it('takes an override class', () => {
    expect(note('x', 'jira-detail-hint').className).toBe('jira-detail-hint')
  })
})

describe('mkBtn', () => {
  it('sets the title and runs the handler on click', () => {
    const onClick = vi.fn()
    const btn = mkBtn('plus', 'Add', onClick)
    expect(btn.title).toBe('Add')
    btn.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('detailHeader', () => {
  it('shows the title followed by the given actions', () => {
    const action = document.createElement('button')
    const bar = detailHeader('Detail', action)
    expect(bar.querySelector('.jira-title')!.textContent).toBe('Detail')
    expect(bar.lastElementChild).toBe(action)
  })
})

describe('field', () => {
  it('labels the input and seeds its value', () => {
    const { row, input } = field('Project', 'BEN')
    expect(row.textContent).toBe('Project')
    expect(input.value).toBe('BEN')
    expect(row.contains(input)).toBe(true)
  })

  it('defaults to a text input and an empty value', () => {
    const { input } = field('Label')
    expect(input.type).toBe('text')
    expect(input.value).toBe('')
  })
})
