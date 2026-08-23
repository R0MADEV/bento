import type { DbServer, DbKind } from './dbServer'

// Shape returned by every tabular backend command (SQL rows, EXPLAIN plans…).
export interface TableData { columns: string[]; rows: string[][] }

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
