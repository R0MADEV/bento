function envMap(env: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of env) {
    const i = entry.indexOf('=')
    if (i > 0) map[entry.slice(0, i)] = entry.slice(i + 1)
  }
  return map
}

// MySQL/MariaDB credentials from a container's env. root sees every database,
// so prefer it; fall back to the app user, then to an empty root password.
export function mysqlCreds(env: string[]): { user: string; password: string } {
  const m = envMap(env)
  if (m.MYSQL_ROOT_PASSWORD != null) return { user: 'root', password: m.MYSQL_ROOT_PASSWORD }
  const hasAppUser = m.MYSQL_USER && m.MYSQL_PASSWORD != null
  if (hasAppUser) return { user: m.MYSQL_USER, password: m.MYSQL_PASSWORD }
  return { user: 'root', password: '' }
}

// MongoDB root credentials from a container's env (empty when auth is disabled).
export function mongoCreds(env: string[]): { user: string; password: string } {
  const m = envMap(env)
  return { user: m.MONGO_INITDB_ROOT_USERNAME ?? '', password: m.MONGO_INITDB_ROOT_PASSWORD ?? '' }
}

// PostgreSQL credentials + the default database to connect to for listing.
export function pgCreds(env: string[]): { user: string; password: string; db: string } {
  const m = envMap(env)
  return { user: m.POSTGRES_USER ?? 'postgres', password: m.POSTGRES_PASSWORD ?? '', db: m.POSTGRES_DB ?? 'postgres' }
}
