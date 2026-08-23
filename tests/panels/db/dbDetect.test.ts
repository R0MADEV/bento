// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { detectDocker, detectLocal, resolveCreds } from '../../../src/panels/db/dbDetect'
import type { DbServer } from '../../../src/core/db/dbServer'

const PS = (lines: string[]): string => lines.join('\n')

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(undefined)
})

describe('detectDocker', () => {
  it('maps a recognised container to its engine and published port', async () => {
    mocks.invoke.mockResolvedValue(PS(['pg1|postgres:16|0.0.0.0:55432->5432/tcp']))
    expect(await detectDocker()).toEqual([
      { kind: 'postgres', source: 'docker', host: '127.0.0.1', port: 55432, container: 'pg1' },
    ])
  })

  it('falls back to the engine default when no port is published', async () => {
    mocks.invoke.mockResolvedValue(PS(['r1|redis:7|']))
    expect((await detectDocker())[0]).toMatchObject({ kind: 'redis', port: 6379 })
  })

  it('skips containers that are not databases', async () => {
    mocks.invoke.mockResolvedValue(PS(['web|nginx:latest|0.0.0.0:80->80/tcp']))
    expect(await detectDocker()).toEqual([])
  })

  it('reports nothing instead of throwing when Docker is not running', async () => {
    mocks.invoke.mockRejectedValue(new Error('docker daemon not running'))
    expect(await detectDocker()).toEqual([])
  })
})

describe('detectLocal', () => {
  it('turns each open default port into a local server', async () => {
    mocks.invoke.mockResolvedValue([5432])
    expect(await detectLocal(new Set())).toEqual([
      { kind: 'postgres', source: 'local', host: '127.0.0.1', port: 5432 },
    ])
  })

  it('skips ports already claimed by a Docker container', async () => {
    mocks.invoke.mockResolvedValue([3306, 6379])
    const found = await detectLocal(new Set([3306]))
    expect(found.map(s => s.port)).toEqual([6379])
  })

  it('probes each default port once, with no duplicates', async () => {
    mocks.invoke.mockResolvedValue([])
    await detectLocal(new Set())
    const { ports } = mocks.invoke.mock.calls[0][1] as { ports: number[] }
    expect(new Set(ports).size).toBe(ports.length)
    expect(ports).toContain(3306)
  })

  it('reports nothing when the port probe fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('nope'))
    expect(await detectLocal(new Set())).toEqual([])
  })
})

describe('resolveCreds for Docker servers', () => {
  const docker = (kind: DbServer['kind']): DbServer =>
    ({ kind, source: 'docker', host: '127.0.0.1', port: 1, container: 'c1' })

  it('reads Postgres user, password and maintenance database from the env', async () => {
    mocks.invoke.mockResolvedValue(['POSTGRES_USER=app', 'POSTGRES_PASSWORD=pw', 'POSTGRES_DB=appdb'])
    const s = docker('postgres')
    await resolveCreds(s)
    expect(s).toMatchObject({ user: 'app', password: 'pw', connectDb: 'appdb' })
  })

  it('reads only the password for Redis', async () => {
    mocks.invoke.mockResolvedValue(['REDIS_PASSWORD=secret'])
    const s = docker('redis')
    await resolveCreds(s)
    expect(s.password).toBe('secret')
  })

  it('reads Mongo and MySQL credentials from their own env vars', async () => {
    mocks.invoke.mockResolvedValue(['MONGO_INITDB_ROOT_USERNAME=m', 'MONGO_INITDB_ROOT_PASSWORD=mp'])
    const mongo = docker('mongodb')
    await resolveCreds(mongo)
    expect(mongo).toMatchObject({ user: 'm', password: 'mp' })

    mocks.invoke.mockResolvedValue(['MYSQL_ROOT_PASSWORD=rp'])
    const mysql = docker('mysql')
    await resolveCreds(mysql)
    expect(mysql.password).toBe('rp')
  })

  it('falls back to the engine default user with no password when the container cannot be inspected', async () => {
    mocks.invoke.mockRejectedValue(new Error('no such container'))
    const s = docker('mysql')
    await resolveCreds(s)
    expect(s).toMatchObject({ user: 'root', password: '' })
  })
})

describe('resolveCreds for local servers', () => {
  const local = (kind: DbServer['kind']): DbServer =>
    ({ kind, source: 'local', host: '127.0.0.1', port: 1 })

  it('never inspects a container', async () => {
    await resolveCreds(local('mysql'))
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('uses the conventional superuser per engine and no password', async () => {
    const pg = local('postgres')
    await resolveCreds(pg)
    expect(pg).toMatchObject({ user: 'postgres', password: '', connectDb: 'postgres' })

    const mysql = local('mysql')
    await resolveCreds(mysql)
    expect(mysql).toMatchObject({ user: 'root', password: '' })

    for (const kind of ['mongodb', 'redis'] as const) {
      const s = local(kind)
      await resolveCreds(s)
      expect(s).toMatchObject({ user: '', password: '' })
    }
  })
})
