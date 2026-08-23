import { describe, expect, it } from 'vitest'
import { buildSelectedPatch, changedPaths, diffFileNames, matchingPaths, parseFilePatch, rankFixupCandidates } from '../../../src/core/git/commitWorkflow'

describe('commit workflow file matching', () => {
  it('extracts files from a unified diff', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      'diff --git a/tests/a.test.ts b/tests/a.test.ts',
      '--- a/tests/a.test.ts',
      '+++ b/tests/a.test.ts',
    ].join('\n')
    expect(diffFileNames(raw)).toEqual(['src/a.ts', 'tests/a.test.ts'])
  })

  it('includes old and new paths for renamed files', () => {
    expect(changedPaths('M\tsrc/a.ts\nR100\tsrc/old.ts\tsrc/new.ts')).toEqual([
      'src/a.ts', 'src/old.ts', 'src/new.ts',
    ])
  })

  it('returns unique file matches in commit order', () => {
    expect(matchingPaths(['src/a.ts', 'src/b.ts'], ['README.md', 'src/b.ts', 'src/b.ts']))
      .toEqual(['src/b.ts'])
  })
})

describe('partial patches', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old one',
    '+new one',
    '@@ -10 +10 @@',
    '-old two',
    '+new two',
    '',
  ].join('\n')

  it('splits headers and hunks', () => {
    const parsed = parseFilePatch(patch)
    expect(parsed.file).toBe('src/a.ts')
    expect(parsed.hunks).toHaveLength(2)
  })

  it('builds a patch with only selected hunks', () => {
    const selected = new Map([['src/a.ts', new Set([1])]])
    const result = buildSelectedPatch(patch, new Set(), selected)
    expect(result).not.toContain('new one')
    expect(result).toContain('new two')
    expect(result).toContain('diff --git a/src/a.ts')
  })
})

describe('rankFixupCandidates', () => {
  const candidate = (id: string, over: Partial<{ overlap: number; blame: number; history: number }> = {}) => ({
    id,
    overlap: Array.from({ length: over.overlap ?? 0 }, (_, i) => `f${i}.ts`),
    blame: { score: over.blame ?? 0, files: [] as string[] },
    history: { score: over.history ?? 0, files: [] as string[] },
  })

  const order = (rows: Array<ReturnType<typeof candidate>>): string[] =>
    rankFixupCandidates(rows).map(r => r.id)

  it('puts the commit touching the most of the incoming files first', () => {
    expect(order([candidate('a', { overlap: 1 }), candidate('b', { overlap: 3 })])).toEqual(['b', 'a'])
  })

  it('outranks any blame or history score by a single overlapping file', () => {
    expect(order([
      candidate('scores', { blame: 99, history: 99 }),
      candidate('overlap', { overlap: 1 }),
    ])).toEqual(['overlap', 'scores'])
  })

  it('breaks an overlap tie by the blame score', () => {
    expect(order([
      candidate('a', { overlap: 1, blame: 1 }),
      candidate('b', { overlap: 1, blame: 5 }),
    ])).toEqual(['b', 'a'])
  })

  it('outranks history by blame', () => {
    expect(order([
      candidate('history', { history: 99 }),
      candidate('blame', { blame: 1 }),
    ])).toEqual(['blame', 'history'])
  })

  it('falls back to the history score when overlap and blame tie', () => {
    expect(order([
      candidate('a', { history: 2 }),
      candidate('b', { history: 7 }),
    ])).toEqual(['b', 'a'])
  })

  it('keeps the original order for candidates that score the same', () => {
    expect(order([candidate('first'), candidate('second'), candidate('third')]))
      .toEqual(['first', 'second', 'third'])
  })

  it('does not reorder the array it was given', () => {
    const rows = [candidate('a'), candidate('b', { overlap: 2 })]
    rankFixupCandidates(rows)
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('ranks nothing into nothing', () => {
    expect(rankFixupCandidates([])).toEqual([])
  })
})
