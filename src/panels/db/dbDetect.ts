import { invoke } from '@tauri-apps/api/core'
import { parseDockerPs } from '../../core/db/dockerPs'
import { serverKind } from '../../core/db/serverKind'
import { publishedPort } from '../../core/db/hostPort'
import { mysqlCreds, mongoCreds, pgCreds } from '../../core/db/credentials'
import { DEFAULT_PORT, kindForPort, type DbServer } from '../../core/db/dbServer'
import { isMongo, isPg, isRedis, envValue } from './dbAccess'

export const detectDocker = async (): Promise<DbServer[]> => {
  const raw = await invoke<string>('db_docker_ps').catch(() => '')
  const servers: DbServer[] = []
  for (const c of parseDockerPs(raw)) {
    const kind = serverKind(c.image, c.ports)
    if (!kind) continue
    const port = publishedPort(c.ports, DEFAULT_PORT[kind]) ?? DEFAULT_PORT[kind]
    servers.push({ kind, source: 'docker', host: '127.0.0.1', port, container: c.name })
  }
  return servers
}

export const detectLocal = async (taken: Set<number>): Promise<DbServer[]> => {
  const ports = [...new Set(Object.values(DEFAULT_PORT))]
  const open = await invoke<number[]>('db_check_ports', { ports }).catch(() => [] as number[])
  return open
    .filter(p => !taken.has(p))
    .map(p => ({ kind: kindForPort(p)!, source: 'local', host: '127.0.0.1', port: p } as DbServer))
}

export const resolveCreds = async (s: DbServer): Promise<void> => {
  if (s.source === 'docker' && s.container) {
    const env = await invoke<string[]>('db_inspect_env', { container: s.container }).catch(() => [] as string[])
    if (isPg(s)) {
      const c = pgCreds(env)
      s.user = c.user; s.password = c.password; s.connectDb = c.db
    } else if (isRedis(s)) {
      s.password = envValue(env, 'REDIS_PASSWORD')
    } else {
      const c = isMongo(s) ? mongoCreds(env) : mysqlCreds(env)
      s.user = c.user; s.password = c.password
    }
    return
  }
  // Local (non-Docker): sensible default users per engine; no env to read.
  s.password = ''
  if (isPg(s)) { s.user = 'postgres'; s.connectDb = 'postgres' }
  else if (isMongo(s) || isRedis(s)) { s.user = '' }
  else { s.user = 'root' }
}
