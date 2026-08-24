import { describe, expect, it } from 'vitest'
import { buildReviewFiles, reviewSummary } from '../../../src/core/git/reviewFiles'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  '-old',
  '+new',
  '+extra',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +0,0 @@',
  '-removed',
].join('\n')

const STATUS = 'M  src/a.ts\n M src/b.ts\n'

describe('buildReviewFiles', () => {
  it('returns one entry per changed file', () => {
    const files = buildReviewFiles(DIFF, STATUS)
    expect(files).toHaveLength(2)
  })

  it('attaches file name, additions, deletions and chunk', () => {
    const [a] = buildReviewFiles(DIFF, STATUS)
    expect(a?.file).toBe('src/a.ts')
    expect(a?.additions).toBe(2)
    expect(a?.deletions).toBe(1)
    expect(a?.chunk).toContain('diff --git a/src/a.ts')
  })

  it('attaches git state from status output', () => {
    const [a, b] = buildReviewFiles(DIFF, STATUS)
    expect(a?.state).toBe('staged')
    expect(b?.state).toBe('unstaged')
  })

  it('returns empty array for empty diff', () => {
    expect(buildReviewFiles('', '')).toEqual([])
  })
})

describe('reviewSummary', () => {
  it('sums additions and deletions across all files', () => {
    const files = buildReviewFiles(DIFF, STATUS)
    const s = reviewSummary(files)
    expect(s.additions).toBe(2)
    expect(s.deletions).toBe(2)
    expect(s.files).toBe(2)
  })

  it('returns zeros for empty list', () => {
    expect(reviewSummary([])).toEqual({ files: 0, additions: 0, deletions: 0 })
  })
})
