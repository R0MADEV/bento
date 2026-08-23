// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createDbTree } from '../../../src/panels/db/dbTree'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

const docker = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

function tree(over: { onOpenData?: () => void; onOpenQuery?: () => void } = {}) {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const api = createDbTree({
    element: el,
    onOpenData: over.onOpenData ?? (() => {}),
    onOpenQuery: over.onOpenQuery ?? (() => {}),
  })
  return { el, api }
}

const rows = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.db-row-label')].map(l => l.textContent ?? '')

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('server list', () => {
  it('says nothing was found when there are no servers', () => {
    const { el, api } = tree()
    api.renderServers([])
    expect(el.querySelector('.db-hint')).not.toBeNull()
  })

  it('shows one row per server with its origin and address', () => {
    const { el, api } = tree()
    api.renderServers([docker(), { kind: 'redis', source: 'local', host: '127.0.0.1', port: 6379 }])
    expect(rows(el)).toEqual(['MySQL', 'Redis'])
    const badges = [...el.querySelectorAll('.db-server-badge')].map(b => b.textContent)
    expect(badges[0]).toBe('c1')
    const addrs = [...el.querySelectorAll('.db-server-addr')].map(a => a.textContent)
    expect(addrs).toEqual([':3306', '127.0.0.1:6379'])
  })

  it('replaces the previous list on a re-render', () => {
    const { el, api } = tree()
    api.renderServers([docker()])
    api.renderServers([docker({ kind: 'postgres', port: 5432 })])
    expect(rows(el)).toEqual(['PostgreSQL'])
  })
})

describe('expanding a server', () => {
  it('resolves credentials and lists the databases', async () => {
    const { el, api } = tree()
    api.renderServers([docker()])
    mocks.invoke
      .mockResolvedValueOnce(['MYSQL_ROOT_PASSWORD=pw'])
      .mockResolvedValueOnce(['app', 'other'])
    ;(el.querySelector('.db-row') as HTMLButtonElement).click()
    await flush()
    expect(rows(el)).toEqual(['MySQL', 'app', 'other'])
  })

  it('offers credentials again when the connection fails', async () => {
    const { el, api } = tree()
    api.renderServers([docker()])
    mocks.invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('access denied'))
    ;(el.querySelector('.db-row') as HTMLButtonElement).click()
    await flush()
    expect(el.querySelector('.db-error')).not.toBeNull()
    expect(el.querySelectorAll('.db-input')).toHaveLength(2)
  })

  it('retries with the credentials the user typed', async () => {
    const { el, api } = tree()
    api.renderServers([docker()])
    mocks.invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('access denied'))
    ;(el.querySelector('.db-row') as HTMLButtonElement).click()
    await flush()
    const [userIn, passIn] = [...el.querySelectorAll('.db-input')] as HTMLInputElement[]
    userIn.value = 'root'
    passIn.value = 'pw'
    mocks.invoke.mockResolvedValueOnce(['app'])
    ;(el.querySelector('.db-connect') as HTMLButtonElement).click()
    await flush()
    const args = mocks.invoke.mock.calls.at(-1)![1] as { user: string; password: string }
    expect(args).toMatchObject({ user: 'root', password: 'pw' })
  })

  it('says listing is unsupported for an engine it cannot browse', async () => {
    const { el, api } = tree()
    api.renderServers([{ kind: 'unknown', source: 'local', host: 'h', port: 1 } as unknown as DbServer])
    ;(el.querySelector('.db-row') as HTMLButtonElement).click()
    await flush()
    expect(el.querySelector('.db-note')).not.toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('expanding a database', () => {
  const openDb = async (el: HTMLElement, api: { renderServers: (s: DbServer[]) => void }, tables: string[]): Promise<void> => {
    api.renderServers([docker()])
    mocks.invoke.mockResolvedValueOnce([]).mockResolvedValueOnce(['app'])
    ;(el.querySelector('.db-row') as HTMLButtonElement).click()
    await flush()
    mocks.invoke.mockResolvedValueOnce(tables)
    ;([...el.querySelectorAll('.db-row')][1] as HTMLButtonElement).click()
    await flush()
  }

  it('always offers a free-form query row first', async () => {
    const onOpenQuery = vi.fn()
    const { el, api } = tree({ onOpenQuery })
    await openDb(el, api, ['users'])
    const queryRow = el.querySelector('.db-query-leaf') as HTMLButtonElement
    expect(queryRow).not.toBeNull()
    queryRow.click()
    expect(onOpenQuery).toHaveBeenCalledWith(expect.anything(), 'app', ['users'])
  })

  it('opens the table data when a table is clicked', async () => {
    const onOpenData = vi.fn()
    const { el, api } = tree({ onOpenData })
    await openDb(el, api, ['users'])
    const tableRow = [...el.querySelectorAll('.db-leaf')].find(r => r.textContent?.includes('users')) as HTMLButtonElement
    tableRow.click()
    expect(onOpenData).toHaveBeenCalledWith(expect.anything(), 'app', 'users')
    expect(tableRow.classList.contains('selected')).toBe(true)
  })

  it('marks only one leaf selected at a time', async () => {
    const { el, api } = tree()
    await openDb(el, api, ['users', 'orders'])
    const leaves = [...el.querySelectorAll('.db-leaf')] as HTMLButtonElement[]
    leaves[1].click()
    leaves[2].click()
    expect(el.querySelectorAll('.db-leaf.selected')).toHaveLength(1)
  })

  it('says so when the database has no tables', async () => {
    const { el, api } = tree()
    await openDb(el, api, [])
    expect(el.querySelector('.db-note')).not.toBeNull()
  })

  it('pages a long table list', async () => {
    const { el, api } = tree()
    await openDb(el, api, Array.from({ length: 35 }, (_, i) => `t${i}`))
    expect(el.querySelectorAll('.db-leaf')).toHaveLength(31) // 30 tables + the query row
    ;(el.querySelector('.db-tree-more') as HTMLButtonElement).click()
    expect(el.querySelectorAll('.db-leaf')).toHaveLength(36)
    expect(el.querySelector('.db-tree-more')).toBeNull()
  })
})
