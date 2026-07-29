import { describe, expect, it } from 'vitest'
import { parseConflictFiles, parseConflictHunks, reconstructFromHunks } from '../../../src/core/git/conflictWorkflow'

describe('conflict workflow', () => {
  it('detects every unmerged porcelain state', () => {
    expect(parseConflictFiles('UU src/a.ts\n M clean.ts\nAA new.ts\n')).toEqual(['src/a.ts', 'new.ts'])
  })

  it('parses choices and reconstructs the resolved file', () => {
    const segments = parseConflictHunks('before\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> change\nafter')
    const hunk = segments.find(segment => segment.type === 'hunk')
    if (hunk?.type === 'hunk') hunk.choice = 'both'
    expect(reconstructFromHunks(segments)).toBe('before\ncurrent\nincoming\nafter')
  })
})
