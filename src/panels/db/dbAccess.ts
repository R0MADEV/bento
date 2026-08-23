import { invoke } from '@tauri-apps/api/core'
import type { DbServer, DbKind } from '../../core/db/dbServer'
import type { ForeignKey } from './queryBuilders'

// Shape returned by every tabular backend command (SQL rows, EXPLAIN plans…).
export interface TableData { columns: string[]; rows: string[][] }

// What a grid needs to turn a read-only result into an editable one.
export interface EditMeta {
  s: DbServer
  db: string
  table: string
  pkIdx: number[]
  fkColMap: Map<string, { ref_table: string; ref_column: string }>
}

export const KIND_LABEL: Record<DbKind, string> = {
  mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', postgres: 'PostgreSQL', redis: 'Redis',
}

export const isMongo = (s: DbServer): boolean => s.kind === 'mongodb'
export const isPg = (s: DbServer): boolean => s.kind === 'postgres'
export const isRedis = (s: DbServer): boolean => s.kind === 'redis'

export const envValue = (env: string[], key: string): string =>
  env.find(e => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? ''

// SQL engines share the same grid logic; only the command prefix differs.
export const sqlCmd = (s: DbServer, op: string): string => `db_docker_${isPg(s) ? 'pg' : 'mysql'}_${op}`

export const creds = (s: DbServer): { user: string; password: string } =>
  ({ user: s.user ?? '', password: s.password ?? '' })

// Where to run: a Docker container, or a local server (empty container → host:port).
export const target = (s: DbServer): { container: string; host: string; port: number } =>
  ({ container: s.container ?? '', host: s.host, port: s.port })

export const sqlEscQ = (v: string): string => v.replace(/'/g, "''")

export const parseRedisLines = (raw: string): string[] =>
  raw.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+\)/.test(l))
    .map(l => {
      const m = l.match(/^\d+\)\s+(.*)$/)
      if (!m) return ''
      let v = m[1]
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      return v
    })

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
