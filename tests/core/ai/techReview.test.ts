import { describe, expect, it } from 'vitest'
import { buildMultiAgentReviewMarkdown, buildReviewChainPrompt, buildReviewDoubtSummary, buildReviewPrompt, buildReviewVerificationPrompt, createContextProvider, extractFirstJsonObject, formatReviewResponse, summarizeReviewRun, validateReviewResponse, type ReviewResponse } from '../../../src/core/ai/techReview'

describe('Tech Review', () => {
  it('builds a prompt with the diff and relevant context', () => {
    const prompt = buildReviewPrompt({
      diff: 'diff --git a/src/a.ts b/src/a.ts',
      files: [{ path: 'src/a.ts', content: 'export const a = 1' }],
      contextSources: ['direct'],
    })
    expect(prompt).toContain('diff --git')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('JSON')
  })

  it('accepts a coherent passing response', () => {
    const response: ReviewResponse = {
      verdict: 'pass',
      summary: 'No actionable findings.',
      findings: [],
      contextSources: ['direct'],
    }
    expect(validateReviewResponse(response)).toEqual(response)
  })

  it('rejects pass responses containing findings', () => {
    expect(() => validateReviewResponse({
      verdict: 'pass',
      summary: 'Looks good',
      findings: [{ severity: 'high', file: 'src/a.ts', line: 1, fingerprint: 'bug', title: 'Bug', explanation: 'x', recommendation: 'y' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects a failing response without a high-severity finding', () => {
    expect(() => validateReviewResponse({
      verdict: 'fail',
      summary: 'Needs attention',
      findings: [{ severity: 'medium', file: 'src/a.ts', line: null, fingerprint: 'improve', title: 'Improve', explanation: 'x', recommendation: 'y' }],
      contextSources: ['lexis', 'direct'],
    })).toThrow()
  })

  it('rejects high severity findings unless the verdict fails', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review',
      summary: 'Needs attention',
      findings: [{ severity: 'high', file: 'src/a.ts', line: 1, fingerprint: 'bug', title: 'Bug', explanation: 'x', recommendation: 'y' }],
      contextSources: ['direct'],
    })).toThrow('High-severity findings require a failing verdict')
  })

  it('rejects critical severity findings unless the verdict fails', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review',
      summary: 'Needs attention',
      findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, fingerprint: 'critical-bug', title: 'Bug', explanation: 'x', recommendation: 'y' }],
      contextSources: ['direct'],
    })).toThrow('High-severity findings require a failing verdict')
  })

  it('rejects findings without a fingerprint', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review',
      summary: 'Needs attention',
      findings: [{ severity: 'low', file: 'src/a.ts', line: 1, title: 'Improve', explanation: 'x', recommendation: 'y' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('requires valid context sources', () => {
    expect(() => validateReviewResponse({ verdict: 'pass', summary: 'ok', findings: [], contextSources: ['unknown'] })).toThrow()
  })

  it('rejects absolute file paths in findings', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: '/etc/passwd', line: null, fingerprint: 'path', title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects path traversal in finding file', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: '../secret.ts', line: null, fingerprint: 'path', title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects null bytes in finding file path', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: 'src/a\0b.ts', line: null, fingerprint: 'path', title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects negative line numbers', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: 'src/a.ts', line: -1, fingerprint: 'line', title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects zero as line number', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: 'src/a.ts', line: 0, fingerprint: 'line', title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects more than 50 findings', () => {
    const f = { severity: 'low' as const, file: 'src/a.ts', line: 1, fingerprint: 'x', title: 'x', explanation: 'x', recommendation: 'x' }
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: Array(51).fill(f),
      contextSources: ['direct'],
    })).toThrow()
  })

  it('formats a passing verdict as icon + summary with no findings', () => {
    const md = formatReviewResponse({ verdict: 'pass', summary: 'All good.', findings: [], contextSources: ['direct'] })
    expect(md).toBe('✅ **pass** — All good.')
  })

  it('formats findings with severity, location and recommendation', () => {
    const md = formatReviewResponse({
      verdict: 'fail',
      summary: 'One issue.',
      findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'bug', title: 'Bug', explanation: 'why', recommendation: 'fix it' }],
      contextSources: ['direct'],
    })
    expect(md).toContain('❌ **fail** — One issue.')
    expect(md).toContain('**HIGH** `src/a.ts:10` — Bug')
    expect(md).toContain('why')
    expect(md).toContain('→ fix it')
  })

  it('summarizes consensus across multiple agent reviews', () => {
    const md = buildMultiAgentReviewMarkdown([
      {
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'needs_review',
          summary: 'One issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'cache-race-write', title: 'Race condition in cache write', explanation: 'why', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'needs_review',
          summary: 'Same issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 12, fingerprint: 'cache-race-write', title: 'Cache write can race', explanation: 'why too', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
      {
        label: 'OpenCode',
        agent: 'opencode',
        error: 'Failed to respond',
      },
    ])

    expect(md).toContain('### Consensus')
    expect(md).toContain('[2/2]')
    expect(md).toContain('Claude, Codex')
    expect(md).toContain('### OpenCode')
    expect(md).toContain('Failed to respond')
  })

  it('counts consensus by unique agent labels', () => {
    const md = buildMultiAgentReviewMarkdown([
      {
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'needs_review',
          summary: 'One issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'cache-race-write', title: 'Race condition in cache write', explanation: 'why', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'needs_review',
          summary: 'Same issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 12, fingerprint: 'cache-race-write', title: 'Cache write can race', explanation: 'why too', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'needs_review',
          summary: 'Verifier repeat.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 12, fingerprint: 'cache-race-write', title: 'Cache write can race', explanation: 'why too', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
    ])

    expect(md).toContain('[2/2]')
    expect(md).not.toContain('[2/3]')
  })

  it('groups the same fingerprint even when titles and nearby lines differ', () => {
    const md = buildMultiAgentReviewMarkdown([
      {
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'needs_review',
          summary: 'One issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'cache-race-write', title: 'Race condition in cache write', explanation: 'why', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'needs_review',
          summary: 'Same issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 12, fingerprint: 'cache-race-write', title: 'Cache write can race', explanation: 'why too', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
    ])

    expect(md).toContain('[2/2]')
    expect(md).toContain('Race condition in cache write')
    expect(md).toContain('Claude, Codex')
  })

  it('does not merge the same fingerprint across different files', () => {
    const md = buildMultiAgentReviewMarkdown([
      {
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'needs_review',
          summary: 'One issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'cache-race-write', title: 'A', explanation: 'why', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'needs_review',
          summary: 'Different file.',
          findings: [{ severity: 'high', file: 'src/b.ts', line: 10, fingerprint: 'cache-race-write', title: 'B', explanation: 'why too', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
    ])

    expect(md).toContain('No repeated findings across agents.')
  })

  it('does not double-count findings from the same agent', () => {
    const md = buildMultiAgentReviewMarkdown([
      {
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'needs_review',
          summary: 'One issue.',
          findings: [
            { severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'cache-race-write', title: 'A', explanation: 'why', recommendation: 'fix it' },
            { severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'cache-race-write', title: 'A again', explanation: 'why', recommendation: 'fix it' },
          ],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'needs_review',
          summary: 'Same issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 12, fingerprint: 'cache-race-write', title: 'B', explanation: 'why too', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
    ])

    expect(md).toContain('[2/2]')
    expect(md).not.toContain('[2/1]')
  })

  it('summarizes a review run compactly', () => {
    const summary = summarizeReviewRun({
      label: 'Claude',
      agent: 'claude',
      response: {
        verdict: 'needs_review',
        summary: 'One issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'bug', title: 'Bug', explanation: 'why', recommendation: 'fix it' }],
        contextSources: ['direct'],
      },
    })

    expect(summary).toContain('Claude: needs_review')
    expect(summary).toContain('- HIGH src/a.ts:10 — Bug')
  })

  it('detects doubts from mismatched verdicts or isolated high severity findings', () => {
    const doubts = buildReviewDoubtSummary([
      {
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'pass',
          summary: 'ok',
          findings: [],
          contextSources: ['direct'],
        },
      },
      {
        label: 'Codex',
        agent: 'codex',
        response: {
          verdict: 'fail',
          summary: 'bad',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'bug', title: 'Bug', explanation: 'why', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      },
    ])

    expect(doubts).toContain('Verdict mismatch')
    expect(doubts).toContain('Isolated high')
  })

  it('builds chained prompts from previous agent findings', () => {
    const prompt = buildReviewChainPrompt({
      stage: 3,
      basePrompt: 'BASE PROMPT '.repeat(4000),
      previousRuns: [{
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'needs_review',
          summary: 'One issue.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 10, fingerprint: 'bug', title: 'Bug', explanation: 'why', recommendation: 'fix it' }],
          contextSources: ['direct'],
        },
      }],
    })

    expect(prompt.slice(0, 28000)).toContain('tercer especialista')
    expect(prompt.slice(0, 28000)).toContain('<previous_results>')
    expect(prompt).toContain('BASE PROMPT')
    expect(prompt).toContain('"verdict": "needs_review"')
    expect(prompt).toContain('"title": "Bug"')
    expect(prompt).not.toContain('"explanation"')
  })

  it('keeps a later high severity finding in the chained prompt', () => {
    const prompt = buildReviewChainPrompt({
      stage: 2,
      basePrompt: 'BASE',
      previousRuns: [{
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'fail',
          summary: 'Many issues.',
          findings: [
            { severity: 'low', file: 'src/a.ts', line: 1, fingerprint: 'a', title: 'A', explanation: 'x', recommendation: 'y' },
            { severity: 'medium', file: 'src/b.ts', line: 2, fingerprint: 'b', title: 'B', explanation: 'x', recommendation: 'y' },
            { severity: 'low', file: 'src/c.ts', line: 3, fingerprint: 'c', title: 'C', explanation: 'x', recommendation: 'y' },
            { severity: 'high', file: 'src/d.ts', line: 4, fingerprint: 'd', title: 'D', explanation: 'x', recommendation: 'y' },
          ],
          contextSources: ['direct'],
        },
      }],
    })

    expect(prompt).toContain('"fingerprint": "d"')
    expect(prompt).toContain('"severity": "high"')
  })

  it('builds a focused verification prompt when doubts exist', () => {
    const prompt = buildReviewVerificationPrompt({
      basePrompt: 'BASE PROMPT '.repeat(4000),
      doubtSummary: '- Verdict mismatch: pass, fail',
      previousRuns: [{
        label: 'Claude',
        agent: 'claude',
        response: {
          verdict: 'pass',
          summary: 'ok',
          findings: [],
          contextSources: ['direct'],
        },
      }],
    })

    expect(prompt.slice(0, 28000)).toContain('verificador focalizado')
    expect(prompt.slice(0, 28000)).toContain('<previous_results>')
    expect(prompt).toContain('Verdict mismatch')
    expect(prompt).toContain('"verdict": "pass"')
  })

  it('omits the line suffix when a finding has no line', () => {
    const md = formatReviewResponse({
      verdict: 'needs_review',
      summary: 'Check.',
      findings: [{ severity: 'low', file: 'src/a.ts', line: null, fingerprint: 'x', title: 'x', explanation: 'y', recommendation: 'z' }],
      contextSources: ['direct'],
    })
    expect(md).toContain('⚠️ **needs_review** — Check.')
    expect(md).toContain('`src/a.ts`')
    expect(md).not.toContain('src/a.ts:')
  })

  it('extracts the first balanced JSON object from surrounding text', () => {
    expect(extractFirstJsonObject('before {"a":1} after')).toBe('{"a":1}')
  })

  it('ignores braces inside JSON strings when extracting', () => {
    expect(extractFirstJsonObject('{"a":"}"}')).toBe('{"a":"}"}')
  })

  it('returns null when there is no JSON object', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull()
  })

  it('falls back to git and direct context when Lexis is unavailable', async () => {
    const provider = createContextProvider({
      lexis: async () => { throw new Error('timeout') },
      git: async () => [{ path: 'src/ref.ts', content: 'ref', reason: 'reference' }],
      direct: async () => [{ path: 'src/changed.ts', content: 'changed', reason: 'changed' }],
    })
    await expect(provider.collect({ repoRoot: '/repo', diff: 'diff', changedFiles: ['src/changed.ts'] })).resolves.toMatchObject({
      sources: ['git', 'direct'], lexisAvailable: false,
    })
  })
})
