import { invoke } from '@tauri-apps/api/core'
import type { DbServer } from '../../core/db/dbServer'
import { isMongo, isPg, isRedis, sqlCmd, creds, target, sqlEscQ, type TableData } from '../../core/db/dbEngine'
import type { ForeignKey } from './queryBuilders'

// What a grid needs to turn a read-only result into an editable one.
export interface EditMeta {
  s: DbServer
  db: string
  table: string
  pkIdx: number[]
  fkColMap: Map<string, { ref_table: string; ref_column: string }>
}

export const listDatabases = (s: DbServer): Promise<string[]> => {
  if (isRedis(s)) return invoke<string[]>('db_docker_redis_dbs', { ...target(s), password: s.password ?? '' })
  if (isMongo(s)) return invoke<string[]>('db_docker_list_mongo', { ...target(s), ...creds(s) })
  if (isPg(s)) return invoke<string[]>('db_docker_pg_databases', { ...target(s), db: s.connectDb ?? 'postgres', ...creds(s) })
  return invoke<string[]>('db_docker_list_mysql', { ...target(s), ...creds(s) })
}

export const listTables = (s: DbServer, db: string): Promise<string[]> => {
  if (isRedis(s)) return invoke<string[]>('db_docker_redis_keys', { ...target(s), db, password: s.password ?? '' })
  const cmd = isMongo(s) ? 'db_docker_mongo_collections' : sqlCmd(s, 'tables')
  return invoke<string[]>(cmd, { ...target(s), db, ...creds(s) })
}

// DB relations: FKs in SQL, heuristic references in Mongo, nothing in Redis.
export const fetchRelations = (s: DbServer, db: string): Promise<ForeignKey[]> => {
  if (isRedis(s)) return Promise.resolve([])
  const cmd = isMongo(s) ? 'db_docker_mongo_refs' : sqlCmd(s, 'fks')
  return invoke<ForeignKey[]>(cmd, { ...target(s), db, ...creds(s) }).catch(() => [] as ForeignKey[])
}

export const fetchColumns = async (s: DbServer, db: string, table: string): Promise<string[]> => {
  try {
    if (isMongo(s)) {
      const esc = sqlEscQ
      const script = `Object.keys(db.getSiblingDB('${esc(db)}').getCollection('${esc(table)}').findOne()||{}).join('\\n')`
      const out = await invoke<string>('db_docker_mongo_query', { ...target(s), db, script, ...creds(s) })
      return out.split('\n').map(x => x.trim()).filter(Boolean)
    }
    if (isPg(s)) {
      const parts = table.split('.')
      const tbl = parts.pop() ?? table
      const schema = parts.pop() ?? 'public'
      const sql = `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='${sqlEscQ(schema)}' AND table_name='${sqlEscQ(tbl)}' ORDER BY ordinal_position`
      const data = await invoke<TableData>('db_docker_pg_query', { ...target(s), db, sql, ...creds(s) })
      return data.rows.map(r => `${r[0]} (${r[1]})`)
    }
    const sql = `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${sqlEscQ(db)}' AND TABLE_NAME='${sqlEscQ(table)}' ORDER BY ORDINAL_POSITION`
    const data = await invoke<TableData>('db_docker_mysql_query', { ...target(s), db, sql, ...creds(s) })
    return data.rows.map(r => `${r[0]} (${r[1]})`)
  } catch {
    return []
  }
}
