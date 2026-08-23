import { describe, expect, it } from 'vitest'
import { candidatePayload, planCandidateImport } from '../../../src/core/memory/memoryImportPlan'
import type { ImportedMemoryCandidate } from '../../../src/core/memory/memorySource'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'

const candidate = (over: Partial<ImportedMemoryCandidate> = {}): ImportedMemoryCandidate => ({
  title: 'A title', summary: 'short', details: 'brief', source: 'claude',
  externalId: 'claude:new', createdAt: '2026-01-01T00:00:00.000Z', files: ['a.ts'], tags: ['x'], ...over,
})

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'e1', projectPath: '/p', kind: 'note', title: 'A title', summary: 'short', details: 'brief',
  source: 'claude', externalId: 'claude:old', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

describe('candidatePayload', () => {
  it('carries the candidate over as a note, stamped with the given update time', () => {
    const payload = candidatePayload(candidate(), '2026-08-23T00:00:00.000Z')
    expect(payload).toMatchObject({
      kind: 'note', title: 'A title', source: 'claude', externalId: 'claude:new',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
    })
  })
})

describe('planCandidateImport', () => {
  it('stamps the payload with now by default', () => {
    const before = Date.now()
    const plan = planCandidateImport('/p', candidate(), [])
    if (plan.action !== 'create') throw new Error('expected a create')
    expect(new Date(plan.payload.updatedAt as string).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('stamps the payload with the time it is given', () => {
    const plan = planCandidateImport('/p', candidate(), [], '2020-05-05T00:00:00.000Z')
    if (plan.action !== 'create') throw new Error('expected a create')
    expect(plan.payload.updatedAt).toBe('2020-05-05T00:00:00.000Z')
  })

  it('creates when nothing like it exists', () => {
    const plan = planCandidateImport('/p', candidate(), [])
    expect(plan.action).toBe('create')
    if (plan.action === 'create') expect(plan.payload.externalId).toBe('claude:new')
  })

  it('skips a candidate already imported under the same external id', () => {
    const plan = planCandidateImport('/p', candidate({ externalId: 'claude:same' }),
      [entry({ id: 'kept', externalId: 'claude:same' })])
    expect(plan).toEqual({ action: 'skip', entryId: 'kept' })
  })

  it('merges into a semantically equal entry rather than duplicating it', () => {
    const plan = planCandidateImport('/p', candidate(), [entry({ id: 'dup', title: 'A title' })])
    expect(plan.action).toBe('merge')
    if (plan.action === 'merge') expect(plan.entry.id).toBe('dup')
  })
})

describe('the merge patch', () => {
  // The entries must actually look alike for a merge to be planned: similarity
  // is containment of title + summary + details.
  const merge = (existingOver: Partial<MemoryEntry>, candOver: Partial<ImportedMemoryCandidate> = {}) => {
    const plan = planCandidateImport('/p', candidate(candOver), [entry({ id: 'dup', ...existingOver })])
    if (plan.action !== 'merge') throw new Error('expected a merge')
    return plan.patch
  }

  it('unions tags and files without duplicating them', () => {
    const patch = merge({ tags: ['x', 'y'], files: ['a.ts', 'b.ts'] })
    expect(patch.tags).toEqual(['x', 'y'])
    expect(patch.files).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps the details it already had when they say more', () => {
    expect(merge({ details: 'brief and then some' }).details).toBe('brief and then some')
  })

  it('takes the incoming details when they say more', () => {
    expect(merge({}, { details: 'brief and then some' }).details).toBe('brief and then some')
  })

  it('keeps what it already had on a tie', () => {
    expect(merge({}).summary).toBe('short')
    expect(merge({}).details).toBe('brief')
  })
})
