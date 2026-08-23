import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { isMongo, isRedis, sqlCmd, creds, target, type TableData } from '../../core/db/dbEngine'
import { fetchRelations } from './dbAccess'
import { note } from './dbWidgets'
import type { DbDetailHost } from './dbDetailHost'
import { renderGrid } from './dbTableGrid'
import { renderDocs } from './dbDocsView'
import { renderRedisValue } from './dbRedisView'

/** Opens one table, collection or key in the detail pane, picking the view per engine. */
export const openData = async (host: DbDetailHost, s: DbServer, db: string, name: string): Promise<void> => {
  host.showDetail(note(i18nT('common.loading'), 'db-detail-loading'))
  try {
    if (isRedis(s)) {
      const [v, ttl] = await Promise.all([
        invoke<{ kind: string; value: string }>('db_docker_redis_value', { ...target(s), db, key: name, password: s.password ?? '' }),
        invoke<number>('db_docker_redis_ttl', { ...target(s), db, key: name, password: s.password ?? '' }).catch(() => -2),
      ])
      renderRedisValue(host, s, db, name, v, ttl)
      return
    }
    if (isMongo(s)) {
      const docs = await invoke<string[]>('db_docker_mongo_docs', { ...target(s), db, collection: name, ...creds(s) })
      renderDocs(host, s, db, name, docs)
      return
    }
    const [data, pk] = await Promise.all([
      invoke<TableData>(sqlCmd(s, 'rows'), { ...target(s), db, table: name, ...creds(s) }),
      invoke<string[]>(sqlCmd(s, 'pk'), { ...target(s), db, table: name, ...creds(s) }).catch(() => [] as string[]),
    ])
    // Relations fill the map in the background: the grid reads it lazily when a
    // foreign-key cell is edited, so the rows need not wait for them.
    const fkColMap = new Map<string, { ref_table: string; ref_column: string }>()
    fetchRelations(s, db).then(fks => {
      fks.filter(f => f.table === name).forEach(f => fkColMap.set(f.column, { ref_table: f.ref_table, ref_column: f.ref_column }))
    }).catch(() => {})
    renderGrid(host, s, db, name, data, pk, fkColMap, () => openData(host, s, db, name))
  } catch (e) {
    host.showDetail(note(String(e), 'db-detail-error'))
  }
}
