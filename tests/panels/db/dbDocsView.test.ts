// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { renderDocs, DOCS_PAGE } from '../../../src/panels/db/dbDocsView'
import type { DbDetailHost } from '../../../src/panels/db/dbDetailHost'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let shown: HTMLElement[]
let alerts: string[]
let confirmed: boolean

const host = (): DbDetailHost => ({
  showDetail: (...nodes) => { shown = nodes; document.body.replaceChildren(...nodes) },
  detailHead: (path, count) => {
    const el = document.createElement('div')
    el.className = 'db-detail-head'
    el.dataset.path = path
    el.dataset.count = count
    return el
  },
})

const server = (): DbServer =>
  ({ kind: 'mongodb', source: 'docker', host: '127.0.0.1', port: 27017, container: 'm1' })

const docs = (n: number): string[] => Array.from({ length: n }, (_, i) => `{"_id":${i}}`)

const show = (list: string[]): void => { renderDocs(host(), server(), 'app', 'users', list) }

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
  shown = []
  alerts = []
  confirmed = true
  vi.stubGlobal('confirm', () => confirmed)
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
  vi.useRealTimers()
})

describe('listing', () => {
  it('pretty-prints each document under a header naming the collection', () => {
    show(['{"a":1}'])
    expect((shown[0] as HTMLElement).dataset.path).toBe('app.users')
    expect(document.querySelector('.db-doc')!.textContent).toBe('{\n  "a": 1\n}')
  })

  it('says the collection is empty when there are no documents', () => {
    show([])
    expect(document.querySelector('.db-doc-item')).toBeNull()
    expect(document.querySelector('.db-note')).not.toBeNull()
  })

  it('pages long collections and drops the button on the last page', () => {
    show(docs(DOCS_PAGE + 3))
    expect(document.querySelectorAll('.db-doc-item')).toHaveLength(DOCS_PAGE)
    ;(document.querySelector('.db-load-more') as HTMLButtonElement).click()
    expect(document.querySelectorAll('.db-doc-item')).toHaveLength(DOCS_PAGE + 3)
    expect(document.querySelector('.db-load-more')).toBeNull()
  })

  it('hides documents that do not match the filter', () => {
    vi.useFakeTimers()
    show(['{"name":"ana"}', '{"name":"bea"}'])
    const input = document.querySelector('.db-filter') as HTMLInputElement
    input.value = 'ana'
    input.dispatchEvent(new Event('input'))
    vi.advanceTimersByTime(150)
    const visible = [...document.querySelectorAll('.db-doc-item')].filter(el => (el as HTMLElement).style.display !== 'none')
    expect(visible).toHaveLength(1)
  })
})

describe('editing a document', () => {
  const openEditor = (): HTMLTextAreaElement => {
    ;(document.querySelector('.db-doc') as HTMLElement).dispatchEvent(new MouseEvent('dblclick'))
    return document.querySelector('.db-doc-edit') as HTMLTextAreaElement
  }

  it('opens an editor prefilled with the document', () => {
    show(['{"a":1}'])
    expect(openEditor().value).toBe('{\n  "a": 1\n}')
  })

  it('restores the original document on cancel', () => {
    show(['{"a":1}'])
    openEditor()
    ;(document.querySelector('.db-doc-cancel') as HTMLButtonElement).click()
    expect(document.querySelector('.db-doc')!.textContent).toBe('{\n  "a": 1\n}')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('replaces the document after confirmation and shows the new content', async () => {
    show(['{"a":1}'])
    openEditor().value = '{"a":2}'
    ;(document.querySelector('.db-doc-actions .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_mongo_update', expect.objectContaining({
      collection: 'users', doc: '{"a":2}',
    }))
    expect(document.querySelector('.db-doc')!.textContent).toBe('{\n  "a": 2\n}')
  })

  it('does not write when the confirmation is refused', async () => {
    confirmed = false
    show(['{"a":1}'])
    openEditor().value = '{"a":2}'
    ;(document.querySelector('.db-doc-actions .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('keeps the editor open and reports the error when the update fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('immutable field _id'))
    show(['{"a":1}'])
    openEditor().value = '{"a":2}'
    ;(document.querySelector('.db-doc-actions .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(alerts.join()).toContain('immutable field _id')
    expect(document.querySelector('.db-doc-edit')).not.toBeNull()
  })
})

describe('deleting a document', () => {
  it('removes the item after confirmation', async () => {
    show(['{"a":1}'])
    ;(document.querySelector('.db-doc-del') as HTMLButtonElement).click()
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_mongo_delete', expect.anything())
    expect(document.querySelector('.db-doc-item')).toBeNull()
  })

  it('keeps the item when the confirmation is refused', async () => {
    confirmed = false
    show(['{"a":1}'])
    ;(document.querySelector('.db-doc-del') as HTMLButtonElement).click()
    await flush()
    expect(document.querySelector('.db-doc-item')).not.toBeNull()
  })
})

describe('adding a document', () => {
  const openNew = (): HTMLTextAreaElement => {
    ;(document.querySelector('.db-result-toolbar .db-action') as HTMLButtonElement).click()
    return document.querySelector('.db-new-doc-wrap textarea') as HTMLTextAreaElement
  }

  it('inserts the document and reloads the collection', async () => {
    show(['{"a":1}'])
    openNew().value = '{"b":2}'
    mocks.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(['{"b":2}'])
    ;(document.querySelector('.db-new-doc-wrap .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(mocks.invoke.mock.calls[0][0]).toBe('db_docker_mongo_query')
    expect((mocks.invoke.mock.calls[0][1] as { script: string }).script).toContain('insertOne({"b":2})')
    expect(mocks.invoke.mock.calls[1][0]).toBe('db_docker_mongo_docs')
  })

  it('keeps the draft and reports the error when the insert fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('bad JSON'))
    show([])
    openNew().value = '{oops'
    ;(document.querySelector('.db-new-doc-wrap .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(alerts.join()).toContain('bad JSON')
    expect(document.querySelector('.db-new-doc-wrap')).not.toBeNull()
  })

  it('discards the draft on cancel', () => {
    show([])
    openNew()
    ;(document.querySelector('.db-new-doc-wrap .db-doc-cancel') as HTMLButtonElement).click()
    expect(document.querySelector('.db-new-doc-wrap')).toBeNull()
  })

  it('replaces an open draft instead of stacking a second one', () => {
    show([])
    openNew()
    openNew()
    expect(document.querySelectorAll('.db-new-doc-wrap')).toHaveLength(1)
  })
})
