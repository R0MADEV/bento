import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { candidateProject, computePreviewCandidateState } from '../../../src/core/memory/memoryCandidates'
import type { ImportDecision } from '../../../src/core/memory/dedup'
import type { ImportedMemoryCandidate } from '../../../src/core/memory/memorySource'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'

const candidate = (over: Partial<ImportedMemoryCandidate> = {}): ImportedMemoryCandidate => ({
  title: 'A title', summary: 's', details: '', source: 'claude',
  externalId: 'claude:abc', createdAt: '2026-01-01T00:00:00.000Z', files: [], tags: [], ...over,
})

const lexis = (over: Partial<ImportedMemoryCandidate> = {}): ImportedMemoryCandidate =>
  candidate({ source: 'source:1', tags: ['lexis'], ...over })

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: '1', projectPath: '/p', kind: 'note', title: 'A title', summary: 's', details: '',
  source: 'claude', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

describe('candidateProject for ordinary candidates', () => {
  it('names the project after the first file', () => {
    expect(candidateProject(candidate({ files: ['/home/ana/bento/src/a.ts'] }))).toBe('a.ts')
  })

  it('falls back to the external id when there are no files', () => {
    expect(candidateProject(candidate({ files: [], externalId: 'claude:abc' }))).toBe('claude:abc')
  })
})

describe('candidateProject for lexis snapshots', () => {
  it('prefers the project the details name', () => {
    expect(candidateProject(lexis({ details: 'Proyecto indexado: /home/ana/bento' }))).toBe('bento')
  })

  it('then an absolute file that is not the lexis index itself', () => {
    expect(candidateProject(lexis({ files: ['/Users/ana/bento'] }))).toBe('bento')
  })

  it('then the folder inside the lexis index path', () => {
    expect(candidateProject(lexis({ files: ['/Users/ana/.lexis/projects/bento/notes.json'] }))).toBe('bento')
  })

  it('then whatever the title says after the snapshot prefix', () => {
    expect(candidateProject(lexis({ title: 'Lexis snapshot · bento' }))).toBe('bento')
  })

  it('gives up with a placeholder when nothing identifies the project', () => {
    expect(candidateProject(lexis({ title: 'Untitled' }))).toBe('Proyecto desconocido')
  })

  it('treats a candidate without the lexis tag as an ordinary one', () => {
    const notLexis = candidate({ source: 'source:1', tags: [], details: 'Proyecto indexado: /home/ana/bento', files: ['/x/y.ts'] })
    expect(candidateProject(notLexis)).toBe('y.ts')
  })
})

// Qué cuenta como duplicado lo decide `bento_memory::dedup`; aquí se comprueba
// cómo se traduce esa decisión a lo que ve quien va a importar.
describe('computePreviewCandidateState', () => {
  const decides = (decision: ImportDecision): void => {
    mocks.invoke.mockImplementation(async () => decision)
  }

  beforeEach(() => { mocks.invoke.mockReset() })

  it('reports no duplicate when the planner says to create it', async () => {
    decides({ action: 'create', payload: entry({ id: 'new' }) })
    expect(await computePreviewCandidateState('/p', candidate(), [])).toEqual({
      duplicateExternal: false, duplicateSemantic: false,
    })
  })

  it('flags an exact re-import and names the entry it would skip', async () => {
    decides({ action: 'skip', entryId: 'kept' })
    const state = await computePreviewCandidateState('/p', candidate(),
      [entry({ id: 'kept', title: 'Already here' })])
    expect(state.duplicateExternal).toBe(true)
    expect(state.duplicateSemantic).toBe(false)
    expect(state.duplicateTitle).toBe('Already here')
  })

  it('flags a semantic duplicate and names what it would merge into', async () => {
    decides({
      action: 'merge',
      entry: entry({ id: 'dup', title: 'A title' }),
      patch: { tags: [], files: [], summary: '', details: '' },
    })
    const state = await computePreviewCandidateState('/p', candidate(), [entry({ id: 'dup' })])
    expect(state.duplicateExternal).toBe(false)
    expect(state.duplicateSemantic).toBe(true)
    expect(state.duplicateTitle).toBe('A title')
  })

  it('asks about the candidate stamped with its own creation time', async () => {
    decides({ action: 'create', payload: entry({ id: 'new' }) })
    await computePreviewCandidateState('/p', candidate({ createdAt: '2020-05-05T00:00:00.000Z' }), [])
    expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ projectPath: '/p', updatedAt: '2020-05-05T00:00:00.000Z' })
  })
})
