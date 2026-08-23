import { t as i18nT } from '../../i18n'
import type { DbServer } from '../../core/db/dbServer'
import { note } from './dbWidgets'

export const HISTORY_LIMIT = 20

export interface DbQueryHistory {
  element: HTMLElement
  getHistory: () => string[]
  saveHistory: (q: string) => void
}

/** Recent queries for one database, kept in localStorage, plus the button that lists them. */
export function createQueryHistory(s: DbServer, db: string, onPick: (query: string) => void): DbQueryHistory {
  const key = `bento.db.qhist.${s.kind}.${db}`

  const getHistory = (): string[] => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[] } catch { return [] }
  }

  const saveHistory = (q: string): void => {
    const h = [q, ...getHistory().filter(x => x !== q)].slice(0, HISTORY_LIMIT)
    localStorage.setItem(key, JSON.stringify(h))
  }

  const btn = document.createElement('button')
  btn.className = 'db-connect'
  btn.title = i18nT('db.queryHistory')
  btn.textContent = '⏱'

  const drop = document.createElement('div')
  drop.className = 'db-hist-drop hidden'

  // A single outside-click listener, re-armed each time the dropdown opens.
  let offClick: (() => void) | null = null
  btn.addEventListener('click', e => {
    e.stopPropagation()
    if (offClick) { document.removeEventListener('click', offClick); offClick = null }
    const h = getHistory()
    drop.replaceChildren()
    if (!h.length) {
      drop.append(note(i18nT('db.noHistory'), 'db-detail-hint'))
    } else {
      h.forEach(q => {
        const item = document.createElement('button')
        item.className = 'db-hist-item'
        item.textContent = q.split('\n')[0].slice(0, 80)
        item.title = q
        item.addEventListener('click', () => { drop.classList.add('hidden'); onPick(q) })
        drop.appendChild(item)
      })
    }
    drop.classList.toggle('hidden')
    if (drop.classList.contains('hidden')) return
    offClick = (): void => { drop.classList.add('hidden'); offClick = null }
    setTimeout(() => { if (offClick) document.addEventListener('click', offClick, { once: true }) }, 0)
  })

  const element = document.createElement('div')
  element.className = 'db-hist-wrap'
  element.append(btn, drop)

  return { element, getHistory, saveHistory }
}
