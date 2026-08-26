import { describe, expect, it } from 'vitest'
import { parseConflictHunks, reconstructFromHunks } from '../../../src/core/git/conflictWorkflow'

describe('conflict workflow', () => {
  it('parses choices and reconstructs the resolved file', () => {
    const segments = parseConflictHunks('before\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> change\nafter')
    const hunk = segments.find(segment => segment.type === 'hunk')
    if (hunk?.type === 'hunk') hunk.choice = 'both'
    expect(reconstructFromHunks(segments)).toBe('before\ncurrent\nincoming\nafter')
  })
})
