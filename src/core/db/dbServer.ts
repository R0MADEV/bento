export type DbKind = 'mysql' | 'mariadb' | 'mongodb' | 'postgres' | 'redis'

export interface DbServer {
  kind: DbKind
  source: 'docker' | 'local'
  host: string
  port: number
  container?: string
  user?: string
  password?: string
  // PostgreSQL: the maintenance database to connect to when listing databases.
  connectDb?: string
}

// Default listening port per engine, used both to find the published Docker port
// and to probe localhost for a non-Docker server.
export const DEFAULT_PORT: Record<DbKind, number> = {
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  postgres: 5432,
  redis: 6379,
}

// Engines we can connect to and list databases from (the rest are detect-only).
export const LISTABLE: DbKind[] = ['mysql', 'mariadb', 'mongodb', 'postgres', 'redis']

// Reverse of DEFAULT_PORT for local detection (3306 reports mysql, not mariadb,
// since they're indistinguishable without connecting).
export function kindForPort(port: number): DbKind | null {
  const entry = (Object.entries(DEFAULT_PORT) as [DbKind, number][]).find(([, p]) => p === port)
  return entry ? entry[0] : null
}
