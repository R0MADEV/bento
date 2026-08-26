// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { builtSql, fakeDbSql } from '../../helpers/dbSql'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  askAi: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../src/ui/askAi', () => ({ askAi: mocks.askAi }))

import { openQuery } from '../../../src/panels/db/dbQueryView'
import type { DbDetailHost } from '../../../src/panels/db/dbDetailHost'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let shown: HTMLElement[]

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

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const open = (s = server()): void => { openQuery(host(), s, 'app', ['users']) }

const editor = (): HTMLTextAreaElement => document.querySelector('.db-query-input') as HTMLTextAreaElement
const results = (): HTMLElement => document.querySelector('.db-grid-scroll') as HTMLElement
const runBtn = (): HTMLButtonElement => document.querySelector('.db-query-actions .db-connect') as HTMLButtonElement

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
  shown = []
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) =>
    fakeDbSql(cmd, args as Record<string, unknown>) ?? { columns: ['id'], rows: [['1']] })
  mocks.askAi.mockReset()
})

describe('layout', () => {
  it('shows the editor, the actions and an empty result area under a header', () => {
    open()
    expect((shown[0] as HTMLElement).dataset.count).toBe('MySQL')
    expect(editor()).not.toBeNull()
    expect(document.querySelector('.db-query-actions')).not.toBeNull()
    expect(results().querySelector('.db-detail-hint')).not.toBeNull()
  })

  it('hints the right language per engine', () => {
    open(server({ kind: 'mongodb' }))
    const mongo = editor().placeholder
    open(server({ kind: 'redis' }))
    const redis = editor().placeholder
    open()
    expect(new Set([mongo, redis, editor().placeholder]).size).toBe(3)
  })

  it('offers the JOIN builder on SQL but not on Mongo', () => {
    open()
    expect(document.querySelector('.db-join-add')).not.toBeNull()
    open(server({ kind: 'mongodb' }))
    expect(document.querySelector('.db-join-add')).toBeNull()
  })
})

describe('running a query', () => {
  it('does nothing for an empty editor', async () => {
    open()
    await flush()
    mocks.invoke.mockClear() // opening the view already loaded the relations
    runBtn().click()
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('runs on click and shows the result grid', async () => {
    open()
    editor().value = 'SELECT id FROM users LIMIT 1'
    runBtn().click()
    await flush()
    expect(results().querySelector('tbody tr')).not.toBeNull()
  })

  it('runs on Cmd/Ctrl+Enter too', async () => {
    open()
    editor().value = 'SELECT id FROM users LIMIT 1'
    editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
    await flush()
    expect(mocks.invoke).toHaveBeenCalled()
  })

  it('remembers the query it just ran', async () => {
    open()
    editor().value = 'SELECT id FROM users LIMIT 1'
    runBtn().click()
    await flush()
    expect(localStorage.getItem('bento.db.qhist.mysql.app')).toContain('SELECT id FROM users')
  })
})

describe('when a query fails', () => {
  beforeEach(() => {
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const built = fakeDbSql(cmd, args as Record<string, unknown>)
      if (built !== undefined) return built
      throw new Error('syntax error near FROM')
    })
  })

  it('shows the error', async () => {
    open()
    editor().value = 'SELECT FROM users'
    runBtn().click()
    await flush()
    expect(results().textContent).toContain('syntax error near FROM')
  })

  it('offers EXPLAIN for a failing SELECT', async () => {
    open()
    editor().value = 'SELECT FROM users'
    runBtn().click()
    await flush()
    expect(results().querySelector('.db-query-run')).not.toBeNull()
  })

  it('offers no EXPLAIN for a non-SELECT or on Mongo and Redis', async () => {
    open()
    editor().value = 'DROP TABLE users'
    runBtn().click()
    await flush()
    expect(results().querySelector('.db-query-run')).toBeNull()

    open(server({ kind: 'mongodb' }))
    editor().value = 'db.users.find()'
    runBtn().click()
    await flush()
    expect(results().querySelector('.db-query-run')).toBeNull()
  })

  it('shows the plan when EXPLAIN is used', async () => {
    open()
    editor().value = 'SELECT FROM users'
    runBtn().click()
    await flush()
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) =>
      fakeDbSql(cmd, args as Record<string, unknown>) ?? { columns: ['type'], rows: [['ALL']] })
    ;(results().querySelector('.db-query-run') as HTMLButtonElement).click()
    await flush()
    expect(results().querySelector('table')).not.toBeNull()
  })

  it('keeps the original error visible when EXPLAIN also fails', async () => {
    open()
    editor().value = 'SELECT FROM users'
    runBtn().click()
    await flush()
    ;(results().querySelector('.db-query-run') as HTMLButtonElement).click()
    await flush()
    expect(results().textContent).toContain('syntax error near FROM')
  })
})

describe('filling the editor', () => {
  it('drops a table example in when its chip is clicked', async () => {
    open()
    ;(document.querySelector('.db-query-chip') as HTMLButtonElement).click()
    await flush()
    expect(editor().value).toBe(builtSql('db_sql_example'))
  })
})
