// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { createQueryHistory, HISTORY_LIMIT } from '../../../src/panels/db/dbQueryHistory'
import type { DbServer } from '../../../src/core/db/dbServer'

const server = (over: Partial<DbServer> = {}): DbServer =>
  ({ kind: 'mysql', source: 'docker', host: '127.0.0.1', port: 3306, container: 'c1', ...over })

const flushTimers = (): Promise<void> => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
})

describe('storage', () => {
  it('starts empty and remembers what it saves', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    expect(h.getHistory()).toEqual([])
    h.saveHistory('SELECT 1')
    expect(h.getHistory()).toEqual(['SELECT 1'])
  })

  it('keeps the newest first and never duplicates a query', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    h.saveHistory('a')
    h.saveHistory('b')
    h.saveHistory('a')
    expect(h.getHistory()).toEqual(['a', 'b'])
  })

  it('drops the oldest entries past the limit', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    for (let i = 0; i <= HISTORY_LIMIT; i++) h.saveHistory(`q${i}`)
    const stored = h.getHistory()
    expect(stored).toHaveLength(HISTORY_LIMIT)
    expect(stored[0]).toBe(`q${HISTORY_LIMIT}`)
    expect(stored).not.toContain('q0')
  })

  it('keeps a separate history per engine and database', () => {
    createQueryHistory(server(), 'app', () => {}).saveHistory('mysql query')
    expect(createQueryHistory(server(), 'other', () => {}).getHistory()).toEqual([])
    expect(createQueryHistory(server({ kind: 'postgres' }), 'app', () => {}).getHistory()).toEqual([])
  })

  it('survives corrupted stored data', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    localStorage.setItem('bento.db.qhist.mysql.app', 'not json')
    expect(h.getHistory()).toEqual([])
  })
})

describe('dropdown', () => {
  it('starts hidden and opens on click', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    document.body.appendChild(h.element)
    const btn = h.element.querySelector('button') as HTMLButtonElement
    const drop = h.element.querySelector('.db-hist-drop') as HTMLElement
    expect(drop.classList.contains('hidden')).toBe(true)
    btn.click()
    expect(drop.classList.contains('hidden')).toBe(false)
  })

  it('says there is no history when nothing was saved', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    ;(h.element.querySelector('button') as HTMLButtonElement).click()
    expect(h.element.querySelector('.db-hist-item')).toBeNull()
    expect(h.element.querySelector('.db-detail-hint')).not.toBeNull()
  })

  it('lists the first line of each query and keeps the whole one as the tooltip', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    h.saveHistory('SELECT *\nFROM users')
    ;(h.element.querySelector('button') as HTMLButtonElement).click()
    const item = h.element.querySelector('.db-hist-item') as HTMLButtonElement
    expect(item.textContent).toBe('SELECT *')
    expect(item.title).toBe('SELECT *\nFROM users')
  })

  it('hands the picked query back and closes', () => {
    const onPick = vi.fn()
    const h = createQueryHistory(server(), 'app', onPick)
    h.saveHistory('SELECT 1')
    ;(h.element.querySelector('button') as HTMLButtonElement).click()
    ;(h.element.querySelector('.db-hist-item') as HTMLButtonElement).click()
    expect(onPick).toHaveBeenCalledWith('SELECT 1')
    expect((h.element.querySelector('.db-hist-drop') as HTMLElement).classList.contains('hidden')).toBe(true)
  })

  it('closes again on a second click of the button', () => {
    const h = createQueryHistory(server(), 'app', () => {})
    const btn = h.element.querySelector('button') as HTMLButtonElement
    const drop = h.element.querySelector('.db-hist-drop') as HTMLElement
    btn.click()
    btn.click()
    expect(drop.classList.contains('hidden')).toBe(true)
  })

  it('closes when the user clicks elsewhere', async () => {
    const h = createQueryHistory(server(), 'app', () => {})
    document.body.appendChild(h.element)
    ;(h.element.querySelector('button') as HTMLButtonElement).click()
    await flushTimers()
    document.body.click()
    expect((h.element.querySelector('.db-hist-drop') as HTMLElement).classList.contains('hidden')).toBe(true)
  })
})
