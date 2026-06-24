import { describe, it, expect } from 'vitest'
import { parseContainers, isRunning } from '../../../src/core/docker/containers'

describe('parseContainers', () => {
  it('parses id|name|image|state|status|ports lines', () => {
    const raw = 'abc123|app-db|mysql:8|running|Up 2 hours|3306/tcp\ndef456|cache|redis:7|exited|Exited (0)|'
    expect(parseContainers(raw)).toEqual([
      { id: 'abc123', name: 'app-db', image: 'mysql:8', state: 'running', status: 'Up 2 hours', ports: '3306/tcp' },
      { id: 'def456', name: 'cache', image: 'redis:7', state: 'exited', status: 'Exited (0)', ports: '' },
    ])
  })

  it('ignores blank lines and trims', () => {
    expect(parseContainers('\n  x|n|i|running|Up|  \n')).toEqual([
      { id: 'x', name: 'n', image: 'i', state: 'running', status: 'Up', ports: '' },
    ])
  })

  it('returns empty for empty input', () => {
    expect(parseContainers('')).toEqual([])
  })
})

describe('isRunning', () => {
  it('is true only for the running state', () => {
    expect(isRunning({ state: 'running' } as never)).toBe(true)
    expect(isRunning({ state: 'exited' } as never)).toBe(false)
    expect(isRunning({ state: 'paused' } as never)).toBe(false)
  })
})
