import { describe, expect, it } from 'vitest'
import { parseReviewCheckpoint } from '../../../src/core/ai/techReview'
import { techReviewCheckpointKey } from '../../../src/core/ai/chatHistory'

describe('parseReviewCheckpoint', () => {
  it('returns null for empty, malformed or shape-invalid data', () => {
    expect(parseReviewCheckpoint(null)).toBeNull()
    expect(parseReviewCheckpoint('')).toBeNull()
    expect(parseReviewCheckpoint('{not json')).toBeNull()
    expect(parseReviewCheckpoint(JSON.stringify({ commit: 'x', branch: 'b' }))).toBeNull()
  })

  it('round-trips a valid checkpoint', () => {
    const cp = { content: '## Revisión', commit: 'abc1234', branch: 'feat/x', sessionId: 's1', sessionAgent: 'claude' as const }
    expect(parseReviewCheckpoint(JSON.stringify(cp))).toEqual(cp)
  })

  it('defaults optional session fields to null', () => {
    const parsed = parseReviewCheckpoint(JSON.stringify({ content: 'x', commit: 'c', branch: 'b' }))
    expect(parsed).toEqual({ content: 'x', commit: 'c', branch: 'b', sessionId: null, sessionAgent: null })
  })
})

describe('techReviewCheckpointKey', () => {
  it('derives a checkpoint key from the conversation key', () => {
    expect(techReviewCheckpointKey('/work/repo/', 'feat/a')).toBe('tech-review:/work/repo:feat/a:checkpoint')
  })
})
