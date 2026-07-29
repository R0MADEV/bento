import { describe, expect, it } from 'vitest'
import { matchesMemoryQuery, sortMemoryEntries } from '../../../src/core/memory/memorySearch'
import { buildMemoryContext, selectMemoryForPrompt } from '../../../src/core/memory/aiContext'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: '1',
  projectPath: '/tmp/bento',
  kind: 'decision',
  title: 'Soporte SQLite',
  summary: 'El panel DB no soporta SQLite todavía.',
  details: 'Hace falta tratar SQLite como archivo y no como servidor.',
  tags: ['bento', 'sqlite'],
  files: ['src/panels/db/DbPanel.ts'],
  source: 'codex',
  createdAt: '2026-07-28T10:00:00.000Z',
  updatedAt: '2026-07-28T11:00:00.000Z',
  ...overrides,
})

describe('matchesMemoryQuery', () => {
  it('matches against title, text, tags and files', () => {
    expect(matchesMemoryQuery(entry(), 'sqlite')).toBe(true)
    expect(matchesMemoryQuery(entry(), 'DbPanel')).toBe(true)
    expect(matchesMemoryQuery(entry(), 'servidor')).toBe(true)
    expect(matchesMemoryQuery(entry(), 'redis')).toBe(false)
  })
})

describe('sortMemoryEntries', () => {
  it('orders newest updates first', () => {
    const items = sortMemoryEntries([
      entry({ id: 'a', updatedAt: '2026-07-28T09:00:00.000Z' }),
      entry({ id: 'b', updatedAt: '2026-07-28T12:00:00.000Z' }),
    ])
    expect(items.map(item => item.id)).toEqual(['b', 'a'])
  })
})

describe('AI memory context', () => {
  it('prefers memories related to the prompt', () => {
    const related = entry({ id: 'related', title: 'SQLite en Bento', updatedAt: '2026-07-28T09:00:00.000Z' })
    const recent = entry({ id: 'recent', title: 'Docker', summary: 'Contenedores', details: 'Usamos Docker Compose.', tags: ['docker'], files: ['compose.yml'], updatedAt: '2026-07-28T12:00:00.000Z' })
    expect(selectMemoryForPrompt([recent, related], 'como guardamos SQLite?').map(item => item.id)).toEqual(['related'])
  })

  it('falls back to recent memories and builds private context', () => {
    const items = selectMemoryForPrompt([entry({ id: 'old', updatedAt: '2026-07-28T09:00:00.000Z' }), entry({ id: 'new', updatedAt: '2026-07-28T12:00:00.000Z' })], 'hola')
    expect(items.map(item => item.id)).toEqual(['new', 'old'])
    expect(buildMemoryContext(items, '/tmp/bento')).toContain('Contexto persistente de Bento')
  })

  it('prioritizes pinned memories and excludes superseded ones', () => {
    const pinned = entry({ id: 'pinned', tags: ['sqlite', 'pinned'], updatedAt: '2026-07-28T08:00:00.000Z' })
    const normal = entry({ id: 'normal', tags: ['sqlite'], updatedAt: '2026-07-28T12:00:00.000Z' })
    const superseded = entry({ id: 'superseded', tags: ['sqlite', 'superseded'], updatedAt: '2026-07-28T13:00:00.000Z' })
    expect(selectMemoryForPrompt([normal, superseded, pinned], 'sqlite').map(item => item.id)).toEqual(['pinned', 'normal'])
  })
})
