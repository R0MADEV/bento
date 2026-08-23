// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { renderRedisValue } from '../../../src/panels/db/dbRedisView'
import type { DbDetailHost } from '../../../src/panels/db/dbDetailHost'
import type { DbServer } from '../../../src/core/db/dbServer'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let shown: HTMLElement[]
let alerts: string[]

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
  ({ kind: 'redis', source: 'docker', host: '127.0.0.1', port: 6379, container: 'r1', password: 'pw' })

const show = (kind: string, value: string, ttl = -1): void => {
  renderRedisValue(host(), server(), '0', 'k1', { kind, value }, ttl)
}

const head = (): HTMLElement => shown[0] as HTMLElement

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
  shown = []
  alerts = []
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('header', () => {
  it('names the database and key', () => {
    show('string', 'hello')
    expect(head().dataset.path).toBe('db0 · k1')
  })

  it('shows the remaining TTL when the key expires', () => {
    show('string', 'hello', 30)
    expect(head().dataset.count).toContain('30')
  })

  it('says the key persists when it has no TTL', () => {
    show('string', 'hello', -1)
    expect(head().dataset.count).toContain('string')
    expect(head().dataset.count).not.toBe('string')
  })

  it('shows the kind alone when the TTL is unknown', () => {
    show('string', 'hello', -2)
    expect(head().dataset.count).toBe('string')
  })
})

describe('value shapes', () => {
  it('says the key is empty when there is no value', () => {
    show('string', '')
    expect(document.querySelector('.db-note')).not.toBeNull()
  })

  it('renders a hash as a field/value table', () => {
    show('hash', '1) "name"\n2) "ana"\n3) "age"\n4) "30"')
    const rows = [...document.querySelectorAll('.db-redis-table tbody tr')]
      .map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))
    expect(rows).toEqual([['name', 'ana'], ['age', '30']])
  })

  it('renders a list and a set as an ordered list', () => {
    show('list', '1) "a"\n2) "b"')
    expect([...document.querySelectorAll('.db-redis-list li')].map(li => li.textContent)).toEqual(['a', 'b'])
    show('set', '1) "x"')
    expect(document.querySelectorAll('.db-redis-list li')).toHaveLength(1)
  })

  it('renders a zset as member/score pairs', () => {
    show('zset', '1) "ana"\n2) "10"')
    const cells = [...document.querySelectorAll('.db-redis-table tbody td')].map(td => td.textContent)
    expect(cells).toEqual(['ana', '10'])
  })

  it('highlights a JSON string value', () => {
    show('string', '{"a":1}')
    expect(document.querySelector('.db-doc .jk')!.textContent).toBe('"a"')
  })

  it('shows a plain string as text', () => {
    show('string', 'just text')
    expect(document.querySelector('.db-doc')!.textContent).toBe('just text')
  })
})

describe('editing a hash field', () => {
  const editFirst = (): HTMLInputElement => {
    const td = document.querySelectorAll('.db-redis-table tbody td')[1] as HTMLElement
    td.dispatchEvent(new MouseEvent('dblclick'))
    return td.querySelector('input') as HTMLInputElement
  }

  it('only makes the value column editable', () => {
    show('hash', '1) "name"\n2) "ana"')
    const tds = document.querySelectorAll('.db-redis-table tbody td')
    expect(tds[0].classList.contains('db-editable')).toBe(false)
    expect(tds[1].classList.contains('db-editable')).toBe(true)
  })

  it('sends HSET with the new value', async () => {
    show('hash', '1) "name"\n2) "ana"')
    const input = editFirst()
    input.value = 'eva'
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_redis_command', expect.objectContaining({
      command: 'HSET k1 name eva', password: 'pw',
    }))
    expect(document.querySelectorAll('.db-redis-table tbody td')[1].textContent).toBe('eva')
  })

  it('does not write when the value is unchanged or on Escape', async () => {
    show('hash', '1) "name"\n2) "ana"')
    editFirst().dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()

    const input = editFirst()
    input.value = 'eva'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('puts the old value back when the write fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('WRONGTYPE'))
    show('hash', '1) "name"\n2) "ana"')
    const input = editFirst()
    input.value = 'eva'
    input.dispatchEvent(new FocusEvent('blur'))
    await flush()
    expect(alerts.join()).toContain('WRONGTYPE')
    expect(document.querySelectorAll('.db-redis-table tbody td')[1].textContent).toBe('ana')
  })
})

describe('editing a string value', () => {
  const openEditor = (): HTMLTextAreaElement => {
    ;(document.querySelector('.db-doc') as HTMLElement).dispatchEvent(new MouseEvent('dblclick'))
    return document.querySelector('.db-doc-edit') as HTMLTextAreaElement
  }

  it('is offered for strings but not for lists', () => {
    show('string', 'hello')
    expect(openEditor()).not.toBeNull()
    show('list', '1) "a"')
    ;(document.querySelector('.db-doc') as HTMLElement | null)?.dispatchEvent(new MouseEvent('dblclick'))
    expect(document.querySelector('.db-doc-edit')).toBeNull()
  })

  it('saves through SET and shows the new value', async () => {
    show('string', 'hello')
    openEditor().value = 'bye'
    ;(document.querySelector('.db-doc-actions .db-connect') as HTMLButtonElement).click()
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('db_docker_redis_set', expect.objectContaining({
      key: 'k1', value: 'bye',
    }))
    expect(document.querySelector('.db-doc')!.textContent).toBe('bye')
  })

  it('restores the original view on cancel', () => {
    show('string', 'hello')
    openEditor()
    ;(document.querySelector('.db-doc-cancel') as HTMLButtonElement).click()
    expect(document.querySelector('.db-doc')!.textContent).toBe('hello')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})

describe('copy', () => {
  it('copies the raw value rather than the rendered table', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    show('hash', '1) "name"\n2) "ana"')
    ;(document.querySelector('.db-result-toolbar .db-action') as HTMLButtonElement).click()
    expect(writeText).toHaveBeenCalledWith('1) "name"\n2) "ana"')
  })
})
