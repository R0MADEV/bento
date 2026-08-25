import { t as i18nT } from '../../i18n'
import type { DbServer } from '../../core/db/dbServer'
import { groupRelations, type ForeignKey } from '../../core/db/queryBuilders'
import { exampleQuery, relationQuery } from '../../core/db/sql'
import { isMongo, isRedis } from '../../core/db/dbEngine'
import { note } from './dbWidgets'

// A large DB has thousands of tables/relations; painting them all as buttons
// (each with a listener) froze the UI. We paint at most this many and let the
// filter re-render the matches from the whole list.
export const CHIP_CAP = 200

export interface QueryChipsDeps {
  s: DbServer
  names: string[]
  relationsReady: Promise<ForeignKey[]>
  onPick: (query: string) => void
}

/** Filterable table and relation chips that fill the editor with an example query. */
export function createQueryChips(deps: QueryChipsDeps): HTMLElement {
  const { s, names, relationsReady, onPick } = deps
  // Filtered search + group toggle. DATA-DRIVEN render with a CAP: a large DB
  // has thousands of tables/relations and painting them all as buttons (each
  // with a listener) froze the UI. We paint at most CHIP_CAP and the filter
  // re-renders the matches from the whole list.
  type Group = 'all' | 'table' | 'rel'
  interface ChipItem { group: 'table' | 'rel'; label: string; title: string; fill: () => Promise<string> }
  let activeGroup: Group = 'all'
  const chipItems: ChipItem[] = names.map(name => ({
    group: 'table', label: name, title: i18nT('db.insertExampleQuery'), fill: () => exampleQuery(s, name),
  }))

  const filter = document.createElement('input')
  filter.className = 'db-query-filter'
  filter.placeholder = i18nT('db.filterTablesRelationships')
  filter.spellcheck = false

  const examples = document.createElement('div')
  examples.className = 'db-query-examples'

  const groupLabel = (g: 'table' | 'rel'): string =>
    g === 'rel' ? i18nT('db.relationsLabel') : isRedis(s) ? i18nT('db.keysLabel') : isMongo(s) ? i18nT('db.collectionsLabel') : i18nT('db.tablesLabel')

  const renderChips = (): void => {
    const q = filter.value.trim().toLowerCase()
    const matches = chipItems.filter(it =>
      (activeGroup === 'all' || it.group === activeGroup) && (!q || it.label.toLowerCase().includes(q)))
    examples.replaceChildren()
    let lastGroup = ''
    matches.slice(0, CHIP_CAP).forEach(it => {
      if (it.group !== lastGroup) {
        lastGroup = it.group
        const lbl = document.createElement('span')
        lbl.className = 'db-query-examples-label'
        lbl.textContent = groupLabel(it.group)
        examples.appendChild(lbl)
      }
      const chip = document.createElement('button')
      chip.className = it.group === 'rel' ? 'db-query-chip db-query-chip-rel' : 'db-query-chip'
      chip.textContent = it.label
      chip.title = it.title
      chip.addEventListener('click', () => { void it.fill().then(onPick) })
      examples.appendChild(chip)
    })
    if (matches.length > CHIP_CAP) {
      examples.appendChild(note(i18nT('db.moreResults', { count: matches.length - CHIP_CAP }), 'db-detail-hint'))
    }
  }
  filter.addEventListener('input', renderChips)

  const toggle = document.createElement('div')
  toggle.className = 'db-query-toggle'
  if (!isRedis(s)) {
    const groups: Array<[Group, string]> = [
      ['all', i18nT('db.allGroup')],
      ['table', isMongo(s) ? i18nT('db.collections') : i18nT('db.tables')],
      ['rel', i18nT('db.relationsLabel')],
    ]
    groups.forEach(([g, label]) => {
      const b = document.createElement('button')
      b.className = g === 'all' ? 'db-query-toggle-btn active' : 'db-query-toggle-btn'
      b.textContent = label
      b.addEventListener('click', () => {
        activeGroup = g
        toggle.querySelectorAll('.db-query-toggle-btn').forEach(x => x.classList.remove('active'))
        b.classList.add('active')
        renderChips()
      })
      toggle.appendChild(b)
    })
  }

  renderChips()

  // Relations (grouped by table) as additional items, after the FKs load.
  if (!isRedis(s)) {
    relationsReady.then(rels => {
      ;[...groupRelations(rels).entries()].forEach(([table, fks]) => {
        chipItems.push({
          group: 'rel',
          label: `${table} ▸ ${fks.map(f => f.ref_table).join(', ')}`,
          title: fks.map(f => `${f.table}.${f.column} → ${f.ref_table}.${f.ref_column}`).join('\n'),
          fill: () => relationQuery(s, table, fks),
        })
      })
      renderChips()
    }).catch(() => {})
  }

  const element = document.createElement('div')
  element.className = 'db-query-chips'
  element.append(filter, toggle, examples)
  return element
}
