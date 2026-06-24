import { describe, it, expect } from 'vitest'
import { serverKind } from '../../../src/core/db/serverKind'

describe('serverKind', () => {
  it('classifies real database containers by image + port', () => {
    expect(serverKind('redis:7-alpine', '6379/tcp')).toBe('redis')
    expect(serverKind('mongo:6', '27017/tcp')).toBe('mongodb')
  })

  it('classifies custom images by their exposed port', () => {
    expect(serverKind('aps-db', '3306/tcp')).toBe('mysql')
    expect(serverKind('pgvector/pgvector:pg17-trixie', '5432/tcp')).toBe('postgres')
  })

  it('rejects tools that ride an engine name but listen elsewhere', () => {
    // redisinsight is a dashboard on 5540, not a Redis server
    expect(serverKind('redis/redisinsight:latest', '0.0.0.0:5540->5540/tcp')).toBeNull()
  })

  it('trusts the image when no port is exposed', () => {
    expect(serverKind('redis:7', '')).toBe('redis')
  })

  it('returns null for non-database containers', () => {
    expect(serverKind('nginx:latest', '80/tcp')).toBeNull()
    expect(serverKind('traefik:v2.11', '0.0.0.0:80->80/tcp')).toBeNull()
  })
})
