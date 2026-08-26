import { t as i18nT } from '../../i18n'
import type { DbServer } from '../../core/db/dbServer'
import type { ForeignKey } from '../../core/db/queryBuilders'
import { joinQuery } from '../../core/db/sql'
import { isMongo, isRedis } from '../../core/db/dbEngine'

// Unique datalist ids: several DB panels can be open at once.
let joinListSeq = 0

export interface JoinBuilderDeps {
  s: DbServer
  names: string[]
  getRelations: () => ForeignKey[]
  relationsReady: Promise<ForeignKey[]>
  onBuild: (query: string) => void
}

/**
 * Deterministic JOIN builder (no AI): you pick tables and Bento finds the JOIN
 * path through the foreign keys. SQL only — Mongo and Redis get an empty node.
 */
export function createJoinBuilder(deps: JoinBuilderDeps): HTMLElement {
  const { s, names, getRelations, relationsReady, onBuild } = deps
  const joinBuilder = document.createElement('div')
  joinBuilder.className = 'db-join-builder'
  if (!isMongo(s) && !isRedis(s)) {
    const picked: string[] = []
    const jLabel = document.createElement('span')
    jLabel.className = 'db-query-examples-label'
    jLabel.textContent = i18nT('db.joinTables')
    const jChips = document.createElement('span')
    jChips.className = 'db-join-chips'
    const jAdd = document.createElement('input')
    jAdd.className = 'db-join-add'
    jAdd.placeholder = i18nT('db.addTable')
    const listId = `db-join-list-${++joinListSeq}`
    jAdd.setAttribute('list', listId)
    const jList = document.createElement('datalist')
    jList.id = listId
    names.forEach(n => { const o = document.createElement('option'); o.value = n; jList.appendChild(o) })
    const jBuild = document.createElement('button')
    jBuild.className = 'db-connect'
    jBuild.textContent = i18nT('db.buildJoin')
    const jMsg = document.createElement('span')
    jMsg.className = 'db-join-msg'

    const renderPicked = (): void => {
      jChips.replaceChildren()
      picked.forEach(t => {
        const c = document.createElement('button')
        c.className = 'db-query-chip db-query-chip-rel'
        c.textContent = `${t} ✕`
        c.title = i18nT('common.remove')
        c.addEventListener('click', () => { picked.splice(picked.indexOf(t), 1); renderPicked() })
        jChips.appendChild(c)
      })
    }
    jAdd.addEventListener('change', () => {
      const v = jAdd.value.trim()
      if (v && names.includes(v) && !picked.includes(v)) { picked.push(v); renderPicked() }
      jAdd.value = ''
    })
    jBuild.addEventListener('click', async () => {
      jMsg.textContent = ''
      if (!picked.length) return
      await relationsReady
      const sql = await joinQuery(s, picked, getRelations())
      if (!sql) { jMsg.textContent = i18nT('db.thoseTablesAreNotConnectedByTheirRelationships'); return }
      onBuild(sql)
    })
    joinBuilder.append(jLabel, jChips, jAdd, jList, jBuild, jMsg)
  }

  return joinBuilder
}
