import { describe, it, expect } from 'vitest'
import { parseContainers, isRunning, groupByProject, runningCount } from '../../../src/core/docker/containers'

describe('parseContainers', () => {
  it('parses id|name|image|state|status|ports|project lines', () => {
    const raw = 'abc|app-db|mysql:8|running|Up 2 hours|3306/tcp|myproj\ndef|cache|redis:7|exited|Exited (0)||'
    expect(parseContainers(raw)).toEqual([
      { id: 'abc', name: 'app-db', image: 'mysql:8', state: 'running', status: 'Up 2 hours', ports: '3306/tcp', project: 'myproj' },
      { id: 'def', name: 'cache', image: 'redis:7', state: 'exited', status: 'Exited (0)', ports: '', project: '' },
    ])
  })

  it('ignores blank lines and trims', () => {
    expect(parseContainers('\n  x|n|i|running|Up||p  \n')).toEqual([
      { id: 'x', name: 'n', image: 'i', state: 'running', status: 'Up', ports: '', project: 'p' },
    ])
  })

  it('returns empty for empty input', () => {
    expect(parseContainers('')).toEqual([])
  })
})

describe('isRunning / runningCount', () => {
  it('isRunning is true only for the running state', () => {
    expect(isRunning({ state: 'running' } as never)).toBe(true)
    expect(isRunning({ state: 'exited' } as never)).toBe(false)
  })
  it('runningCount counts running containers', () => {
    expect(runningCount([{ state: 'running' }, { state: 'exited' }, { state: 'running' }] as never)).toBe(2)
  })
})

describe('groupByProject', () => {
  const c = (name: string, project: string, state = 'running') => ({ name, project, state } as never)

  it('groups by project, sorted, with standalone containers last', () => {
    const groups = groupByProject([c('a', 'zeta'), c('b', ''), c('d', 'alpha'), c('e', 'zeta')])
    expect(groups.map(g => g.project)).toEqual(['alpha', 'zeta', ''])
    expect(groups[1].containers.map((x: { name: string }) => x.name)).toEqual(['a', 'e'])
  })

  it('omits the standalone group when every container has a project', () => {
    expect(groupByProject([c('a', 'p')]).map(g => g.project)).toEqual(['p'])
  })
})
