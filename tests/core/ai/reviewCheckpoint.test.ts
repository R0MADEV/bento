import { describe, expect, it } from 'vitest'
import { buildReviewDocument, parseReviewCheckpoint, isRetryableReviewError, type MultiAgentReviewRun } from '../../../src/core/ai/techReview'
import { techReviewCheckpointKey } from '../../../src/core/ai/chatHistory'

const run = (label: string): MultiAgentReviewRun => ({
  label,
  agent: 'claude',
  report: `${label}: informe en Markdown`,
})

describe('buildReviewDocument', () => {
  it('includes branch, base, short commit and each agent report', () => {
    const doc = buildReviewDocument(
      { branch: 'feat/x', base: 'main', commit: 'abcdef1234', compareAgents: false, fallbackAgentLabel: 'Claude' },
      [run('Claude')],
    )
    expect(doc).toContain('## Revisión: feat/x')
    expect(doc).toContain('Base: `main`')
    expect(doc).toContain('abcdef1')
    expect(doc).toContain('Agent: Claude')
    expect(doc).toContain('Claude: informe en Markdown')
  })

  it('labels each agent section when comparing and keeps error runs', () => {
    const doc = buildReviewDocument(
      { branch: 'b', base: 'main', commit: '0000000', compareAgents: true, fallbackAgentLabel: 'Claude' },
      [run('Claude'), { label: 'Codex', agent: 'codex', error: 'agent timeout' }],
    )
    expect(doc).toContain('### Claude')
    expect(doc).toContain('### Codex')
    expect(doc).toContain('⚠️ agent timeout')
  })

  it('lists every agent label when comparing agents', () => {
    const doc = buildReviewDocument(
      { branch: 'b', base: 'main', commit: '0000000', compareAgents: true, fallbackAgentLabel: 'Claude' },
      [run('Claude'), run('Codex')],
    )
    expect(doc).toContain('Agents: Claude + Codex')
  })

  it('falls back to the given agent label when there are no runs', () => {
    const doc = buildReviewDocument(
      { branch: 'b', base: 'main', commit: '0000000', compareAgents: false, fallbackAgentLabel: 'Claude' },
      [],
    )
    expect(doc).toContain('Agent: Claude')
  })
})

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

describe('isRetryableReviewError', () => {
  it('retries transient infra failures', () => {
    for (const message of ['rate limit exceeded', 'Error 529 overloaded', 'socket hang up', 'ECONNRESET', 'agent exited with an error']) {
      expect(isRetryableReviewError(message)).toBe(true)
    }
  })

  it('does not retry timeouts, deterministic or empty failures', () => {
    for (const message of ['agent timeout', 'agent output too large', 'No JSON object found in response', '']) {
      expect(isRetryableReviewError(message)).toBe(false)
    }
  })
})
