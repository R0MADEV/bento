import { describe, expect, it } from 'vitest'
import { commitFilesRaw, recommendationMap } from '../../../src/panels/tasks/taskGitClient'

describe('task Git typed adapters', () => {
  it('converts typed commit files only at the legacy diff helper boundary', () => {
    expect(commitFilesRaw([
      { status: 'M', paths: ['src/a.ts'] },
      { status: 'R100', paths: ['old.ts', 'new.ts'] },
    ])).toBe('M\tsrc/a.ts\nR100\told.ts\tnew.ts')
  })

  it('indexes typed recommendations by commit hash', () => {
    expect(recommendationMap([{ hash: 'abc', score: 2, files: ['a.ts'] }]).get('abc'))
      .toEqual({ score: 2, files: ['a.ts'] })
  })
})
