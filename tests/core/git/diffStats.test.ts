import { describe, expect, it } from 'vitest'
import { parseDiffFiles } from '../../../src/core/git/diffStats'

const SIMPLE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n')

const MULTI_DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  '-x',
  '+y',
  '+z',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1 +0,0 @@',
  '-w',
].join('\n')

describe('parseDiffFiles', () => {
  it('returns empty array for empty diff', () => {
    expect(parseDiffFiles('')).toEqual([])
    expect(parseDiffFiles('   ')).toEqual([])
  })

  it('extracts file name', () => {
    const [file] = parseDiffFiles(SIMPLE_DIFF)
    expect(file?.file).toBe('src/a.ts')
  })

  it('counts additions and deletions, ignoring header lines', () => {
    const [file] = parseDiffFiles(SIMPLE_DIFF)
    expect(file?.additions).toBe(1)
    expect(file?.deletions).toBe(1)
  })

  it('handles multiple files independently', () => {
    const files = parseDiffFiles(MULTI_DIFF)
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ file: 'a.ts', additions: 2, deletions: 1 })
    expect(files[1]).toMatchObject({ file: 'b.ts', additions: 0, deletions: 1 })
  })

  it('preserves the raw chunk for each file', () => {
    const [file] = parseDiffFiles(SIMPLE_DIFF)
    expect(file?.chunk).toContain('diff --git a/src/a.ts')
    expect(file?.chunk).toContain('+new')
  })

  it('ignores +++ and --- header lines in counts', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '+real',
    ].join('\n')
    expect(parseDiffFiles(diff)[0]?.additions).toBe(1)
    expect(parseDiffFiles(diff)[0]?.deletions).toBe(0)
  })
})
