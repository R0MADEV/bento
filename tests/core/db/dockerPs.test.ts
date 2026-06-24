import { describe, it, expect } from 'vitest'
import { parseDockerPs } from '../../../src/core/db/dockerPs'

describe('parseDockerPs', () => {
  it('parses name|image|ports lines', () => {
    const raw = 'app-db|mysql:8|0.0.0.0:3307->3306/tcp\ncache|redis:7|0.0.0.0:6379->6379/tcp'
    expect(parseDockerPs(raw)).toEqual([
      { name: 'app-db', image: 'mysql:8', ports: '0.0.0.0:3307->3306/tcp' },
      { name: 'cache', image: 'redis:7', ports: '0.0.0.0:6379->6379/tcp' },
    ])
  })

  it('ignores blank lines and trims', () => {
    expect(parseDockerPs('\n  app|mongo:7|  \n\n')).toEqual([
      { name: 'app', image: 'mongo:7', ports: '' },
    ])
  })

  it('returns empty for empty input', () => {
    expect(parseDockerPs('')).toEqual([])
  })
})
