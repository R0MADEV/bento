import { describe, expect, it } from 'vitest'
import { candidateProject, computePreviewCandidateState } from '../../../src/core/memory/memoryCandidates'
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

describe('computePreviewCandidateState', () => {
  it('reports no duplicate against an empty project', () => {
    expect(computePreviewCandidateState('/p', candidate(), [])).toEqual({
      duplicateExternal: false, duplicateSemantic: false, duplicateTitle: undefined,
    })
  })

  it('flags an exact re-import by external id and names it', () => {
    const state = computePreviewCandidateState('/p', candidate({ externalId: 'claude:abc' }),
      [entry({ externalId: 'claude:abc', title: 'Already here' })])
    expect(state.duplicateExternal).toBe(true)
    expect(state.duplicateSemantic).toBe(false)
    expect(state.duplicateTitle).toBe('Already here')
  })

  it('flags a semantic duplicate when the ids differ but the content matches', () => {
    const state = computePreviewCandidateState('/p', candidate({ externalId: 'claude:new', title: 'A title' }),
      [entry({ externalId: 'claude:old', title: 'A title' })])
    expect(state.duplicateExternal).toBe(false)
    expect(state.duplicateSemantic).toBe(true)
    expect(state.duplicateTitle).toBe('A title')
  })

  it('never reports both kinds of duplicate at once', () => {
    const state = computePreviewCandidateState('/p', candidate({ externalId: 'claude:abc' }),
      [entry({ externalId: 'claude:abc' })])
    expect(state.duplicateExternal && state.duplicateSemantic).toBe(false)
  })
})
