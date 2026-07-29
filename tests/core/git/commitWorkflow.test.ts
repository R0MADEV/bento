import { describe, expect, it } from 'vitest'
import { buildSelectedPatch, changedPaths, diffFileNames, matchingPaths, parseFilePatch } from '../../../src/core/git/commitWorkflow'

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
