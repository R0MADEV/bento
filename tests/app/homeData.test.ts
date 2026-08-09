import { describe, it, expect } from 'vitest'
import { resumableAgents, recentProjects } from '../../src/app/homeData'

describe('resumableAgents', () => {
  it('keeps only agents that ran a CLI and captured a session', () => {
    const saved = [
      { name: 'Claude', cwd: '/p', cmd: 'claude', sessionId: 'abc' },
      { name: 'bare terminal', cwd: '/p' },                 // no cmd → nothing to resume
      { name: 'Codex, no convo', cwd: '/p', cmd: 'codex' }, // cmd but no sessionId
      { name: 'empty session id', cwd: '/p', cmd: 'claude', sessionId: '' },
    ]
    expect(resumableAgents(saved).map(a => a.name)).toEqual(['Claude'])
  })

  it('returns [] for non-array or malformed input', () => {
    expect(resumableAgents(null)).toEqual([])
    expect(resumableAgents('nope')).toEqual([])
    expect(resumableAgents([null, {}, { name: 1 }, { cmd: 'claude', sessionId: 'x' }])).toEqual([])
  })
})

describe('recentProjects', () => {
  it('lists unique project folders in order, skipping blanks', () => {
    const agents = [
      { name: 'a', cwd: '/x', cmd: 'claude', sessionId: '1' },
      { name: 'b', cwd: '/y', cmd: 'claude', sessionId: '2' },
      { name: 'c', cwd: '/x', cmd: 'claude', sessionId: '3' }, // duplicate folder
      { name: 'd', cwd: '   ', cmd: 'claude', sessionId: '4' }, // blank
    ]
    expect(recentProjects(agents)).toEqual(['/x', '/y'])
  })
})
