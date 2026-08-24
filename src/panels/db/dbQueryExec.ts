import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { withRowLimit } from '../../core/db/rowLimit'
import type { ForeignKey } from '../../core/db/queryBuilders'
import { isMongo, isPg, isRedis, sqlCmd, creds, target, type TableData } from '../../core/db/dbEngine'
import { pgFixIdents } from '../../core/db/pgIdents'
import { note } from './dbWidgets'
import { renderResultTable, preResult } from './dbResultTable'

export interface DbQueryRunner {
  executeQuery: (text: string) => Promise<HTMLElement>
  explain: (text: string) => Promise<HTMLElement>
}

/** Runs queries against one database and renders the result, editable when it safely can be. */
export function createQueryRunner(
  s: DbServer, db: string, names: string[], relationsReady: Promise<ForeignKey[]>,
): DbQueryRunner {
  // Runs a query and returns the element with the result (table or text).
  // Reused by the editor and by the "Run" button in the AI chat.
  const executeQuery = async (text: string): Promise<HTMLElement> => {
    if (isMongo(s)) return preResult(await invoke<string>('db_docker_mongo_query', { ...target(s), db, script: text, ...creds(s) }))
    if (isRedis(s)) return preResult(await invoke<string>('db_docker_redis_command', { ...target(s), db, command: text, password: s.password ?? '' }))
    const limited = withRowLimit(text)
    // MySQL/MariaDB: with many tables the optimizer takes forever to find the
    // optimal JOIN ORDER (combinatorial explosion during PLANNING, even if the
    // query executes few rows). With depth=1 it plans greedily instantly.
    // Postgres doesn't suffer from this.
    const sql = isPg(s) ? pgFixIdents(limited, names) : `SET SESSION optimizer_search_depth=1; ${limited}`
    const data = await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql, ...creds(s) })

    // Enable editing when the query is a plain SELECT * FROM <table> with no joins or aggregations.
    // Pagination: offer "load more" when the query had no explicit LIMIT (withRowLimit added one).
    const trimmedText = text.trim().replace(/;\s*$/, '')
    const limitWasAdded = !/\blimit\b\s+\d/i.test(trimmedText) && /^(select|with)\b/i.test(trimmedText)
    const loadMore = limitWasAdded
      ? async (offset: number): Promise<string[][]> => {
          const pageSql = `${trimmedText} LIMIT 200 OFFSET ${offset}`
          const moreSql = isPg(s) ? pgFixIdents(pageSql, names) : `SET SESSION optimizer_search_depth=1; ${pageSql}`
          const more = await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql: moreSql, ...creds(s) })
          return more.rows
        }
      : undefined

    const simpleMatch = /^\s*select\s+\*\s+from\s+((?:"[^"]+"\."[^"]+"|"[^"]+"|`[^`]+`|\w+(?:\.\w+)*))\s*(?:limit\s+\d+\s*)?;?\s*$/i.exec(text.trim())
    if (simpleMatch) {
      const rawTable = simpleMatch[1].replace(/["'`]/g, '')
      const matched = names.find(n => n === rawTable || n.split('.').pop() === rawTable.split('.').pop())
      if (matched) {
        try {
          const [pk, allFks] = await Promise.all([
            invoke<string[]>(sqlCmd(s, 'pk'), { ...target(s), db, table: matched, ...creds(s) }).catch(() => [] as string[]),
            relationsReady.catch(() => [] as ForeignKey[]),
          ])
          const pkIdx = pk.map(c => data.columns.indexOf(c)).filter(i => i >= 0)
          const fkColMap = new Map<string, { ref_table: string; ref_column: string }>()
          allFks.filter(f => f.table === matched).forEach(f => fkColMap.set(f.column, { ref_table: f.ref_table, ref_column: f.ref_column }))
          return renderResultTable(data, { s, db, table: matched, pkIdx, fkColMap }, loadMore)
        } catch { /* fall through to read-only */ }
      }
    }

    return renderResultTable(data, undefined, loadMore)
  }

  // EXPLAIN: asks the engine for the execution plan WITHOUT running the query. It's
  // instant and reveals why a query is slow: which table is scanned in full
  // (join type ALL, no index) and how many rows it estimates combining.
  const explain = async (text: string): Promise<HTMLElement> => {
    const raw = text.trim().replace(/;\s*$/, '')
    // With many tables, MySQL/MariaDB takes so long to PLAN the JOIN order that
    // even the EXPLAIN hangs. optimizer_search_depth=1 forces an immediate
    // greedy plan: the diagnostic returns instead of blowing up.
    const sql = isPg(s)
      ? `EXPLAIN ${pgFixIdents(raw, names)}`
      : `SET SESSION optimizer_search_depth=1; EXPLAIN ${raw}`
    const plan = renderResultTable(await invoke<TableData>(sqlCmd(s, 'query'), { ...target(s), db, sql, ...creds(s) }))
    const wrap = document.createElement('div')
    wrap.append(
      note(i18nT('db.executionPlanHighRowCountsOrTypeAll'), 'db-detail-hint'),
      plan,
    )
    return wrap
  }

  return { executeQuery, explain }
}
