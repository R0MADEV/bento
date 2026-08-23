// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({ askAi: vi.fn() }))
vi.mock('../../../src/ui/askAi', () => ({ askAi: mocks.askAi }))

import { createDetailHost } from '../../../src/panels/db/dbDetailHost'

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.askAi.mockReset()
  document.body.replaceChildren()
})

function setup(): { detail: HTMLElement; host: ReturnType<typeof createDetailHost> } {
  const detail = document.createElement('div')
  document.body.appendChild(detail)
  return { detail, host: createDetailHost(detail) }
}

describe('showDetail', () => {
  it('replaces whatever was in the detail pane', () => {
    const { detail, host } = setup()
    detail.appendChild(document.createElement('span'))
    const fresh = document.createElement('p')
    host.showDetail(fresh)
    expect([...detail.children]).toEqual([fresh])
  })
})

describe('detailHead', () => {
  it('shows the path and the count side by side', () => {
    const { host } = setup()
    const bar = host.detailHead('app.users', '12 rows')
    expect(bar.querySelector('.db-detail-path')!.textContent).toBe('app.users')
    expect(bar.querySelector('.db-detail-count')!.textContent).toBe('12 rows')
  })

  it('sends the current view to the AI chat when nothing is selected', () => {
    const { detail, host } = setup()
    const bar = host.detailHead('app.users', '')
    host.showDetail(bar)
    detail.appendChild(Object.assign(document.createElement('pre'), { textContent: 'row data here' }))
    vi.stubGlobal('getSelection', () => ({ toString: () => '' }))
    ;(bar.querySelector('.db-action') as HTMLButtonElement).click()
    expect(mocks.askAi).toHaveBeenCalledTimes(1)
    expect(mocks.askAi.mock.calls[0][0]).toContain('row data here')
    expect(mocks.askAi.mock.calls[0][0]).toContain('app.users')
  })

  it('prefers the user selection over the whole view', () => {
    const { detail, host } = setup()
    const bar = host.detailHead('app.users', '')
    detail.appendChild(Object.assign(document.createElement('pre'), { textContent: 'everything' }))
    vi.stubGlobal('getSelection', () => ({ toString: () => '  just this  ' }))
    ;(bar.querySelector('.db-action') as HTMLButtonElement).click()
    expect(mocks.askAi.mock.calls[0][0]).toContain('just this')
    expect(mocks.askAi.mock.calls[0][0]).not.toContain('everything')
  })

  it('sends nothing when the view is empty', () => {
    const { host } = setup()
    const bar = host.detailHead('app.users', '')
    vi.stubGlobal('getSelection', () => ({ toString: () => '' }))
    ;(bar.querySelector('.db-action') as HTMLButtonElement).click()
    expect(mocks.askAi).not.toHaveBeenCalled()
  })

  it('caps how much context it sends', () => {
    const { detail, host } = setup()
    const bar = host.detailHead('app.users', '')
    detail.appendChild(Object.assign(document.createElement('pre'), { textContent: 'x'.repeat(20000) }))
    vi.stubGlobal('getSelection', () => ({ toString: () => '' }))
    ;(bar.querySelector('.db-action') as HTMLButtonElement).click()
    expect((mocks.askAi.mock.calls[0][0] as string).length).toBeLessThan(13000)
  })
})
