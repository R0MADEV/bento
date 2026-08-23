// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { openData } from '../../../src/panels/db/dbOpenData'
import type { DbDetailHost } from '../../../src/panels/db/dbDetailHost'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let shown: HTMLElement[][]

const host = (): DbDetailHost => ({
  showDetail: (...nodes) => { shown.push(nodes); document.body.replaceChildren(...nodes) },
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

const open = (s = server(), name = 'users'): Promise<void> => openData(host(), s, 'app', name)

const called = (cmd: string): boolean => mocks.invoke.mock.calls.some(c => c[0] === cmd)

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  vi.stubGlobal('confirm', () => true)
  vi.stubGlobal('alert', () => {})
  document.body.replaceChildren()
  shown = []
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('while loading', () => {
  it('shows a loading note before the data arrives', async () => {
    mocks.invoke.mockResolvedValue({ columns: [], rows: [] })
    await open()
    expect((shown[0][0] as HTMLElement).className).toBe('db-detail-loading')
  })
})

describe('SQL tables', () => {
  beforeEach(() => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_docker_mysql_rows') return { columns: ['id'], rows: [['1']] }
      if (cmd === 'db_docker_mysql_pk') return ['id']
      if (cmd === 'db_docker_mysql_fks') return [{ table: 'users', column: 'org_id', ref_table: 'orgs', ref_column: 'id' }]
      return undefined
    })
  })

  it('renders the rows in an editable grid', async () => {
    await open()
    await flush()
    expect(document.querySelector('tbody tr')).not.toBeNull()
    expect(document.querySelector('td.db-editable')).not.toBeNull()
  })

  it('loads rows and primary key together, and relations alongside', async () => {
    await open()
    await flush()
    expect(called('db_docker_mysql_rows')).toBe(true)
    expect(called('db_docker_mysql_pk')).toBe(true)
    expect(called('db_docker_mysql_fks')).toBe(true)
  })

  it('still renders when the primary key cannot be read', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_docker_mysql_rows') return { columns: ['id'], rows: [['1']] }
      if (cmd === 'db_docker_mysql_pk') throw new Error('denied')
      return []
    })
    await open()
    expect(document.querySelector('tbody tr')).not.toBeNull()
    expect(document.querySelector('td.db-editable')).toBeNull()
  })

  it('uses the Postgres backend for Postgres', async () => {
    mocks.invoke.mockResolvedValue({ columns: [], rows: [] })
    await open(server({ kind: 'postgres' }))
    expect(called('db_docker_pg_rows')).toBe(true)
  })
})

describe('Mongo collections', () => {
  it('renders the documents', async () => {
    mocks.invoke.mockResolvedValue(['{"a":1}'])
    await open(server({ kind: 'mongodb' }))
    expect(called('db_docker_mongo_docs')).toBe(true)
    expect(document.querySelector('.db-doc-item')).not.toBeNull()
  })
})

describe('Redis keys', () => {
  it('reads the value and its TTL and renders them', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_docker_redis_value') return { kind: 'string', value: 'hello' }
      if (cmd === 'db_docker_redis_ttl') return 30
      return undefined
    })
    await open(server({ kind: 'redis' }), 'k1')
    expect(document.querySelector('.db-doc')!.textContent).toBe('hello')
    expect((document.querySelector('.db-detail-head') as HTMLElement).dataset.count).toContain('30')
  })

  it('still shows the value when the TTL lookup fails', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_docker_redis_value') return { kind: 'string', value: 'hello' }
      throw new Error('no TTL')
    })
    await open(server({ kind: 'redis' }), 'k1')
    expect(document.querySelector('.db-doc')!.textContent).toBe('hello')
  })
})

describe('failures', () => {
  it('shows the error in the detail pane instead of throwing', async () => {
    mocks.invoke.mockRejectedValue(new Error('table does not exist'))
    await expect(open()).resolves.toBeUndefined()
    expect(document.querySelector('.db-detail-error')!.textContent).toContain('table does not exist')
  })
})
