import { describe, expect, it } from 'vitest'
import { diffFileNames } from '../../../src/core/git/commitWorkflow'

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

})
