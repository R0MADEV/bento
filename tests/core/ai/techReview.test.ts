import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, createContextProvider, extractFirstJsonObject, formatReviewResponse, validateReviewResponse, type ReviewResponse } from '../../../src/core/ai/techReview'

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
      findings: [{ severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug', explanation: 'x', recommendation: 'y' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects a failing response without a high-severity finding', () => {
    expect(() => validateReviewResponse({
      verdict: 'fail',
      summary: 'Needs attention',
      findings: [{ severity: 'medium', file: 'src/a.ts', line: null, title: 'Improve', explanation: 'x', recommendation: 'y' }],
      contextSources: ['lexis', 'direct'],
    })).toThrow()
  })

  it('requires valid context sources', () => {
    expect(() => validateReviewResponse({ verdict: 'pass', summary: 'ok', findings: [], contextSources: ['unknown'] })).toThrow()
  })

  it('rejects absolute file paths in findings', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: '/etc/passwd', line: null, title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects path traversal in finding file', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: '../secret.ts', line: null, title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects null bytes in finding file path', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: 'src/a\0b.ts', line: null, title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects negative line numbers', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: 'src/a.ts', line: -1, title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects zero as line number', () => {
    expect(() => validateReviewResponse({
      verdict: 'needs_review', summary: 'x',
      findings: [{ severity: 'low', file: 'src/a.ts', line: 0, title: 'x', explanation: 'x', recommendation: 'x' }],
      contextSources: ['direct'],
    })).toThrow()
  })

  it('rejects more than 50 findings', () => {
    const f = { severity: 'low' as const, file: 'src/a.ts', line: 1, title: 'x', explanation: 'x', recommendation: 'x' }
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
      findings: [{ severity: 'high', file: 'src/a.ts', line: 10, title: 'Bug', explanation: 'why', recommendation: 'fix it' }],
      contextSources: ['direct'],
    })
    expect(md).toContain('❌ **fail** — One issue.')
    expect(md).toContain('**HIGH** `src/a.ts:10` — Bug')
    expect(md).toContain('why')
    expect(md).toContain('→ fix it')
  })

  it('omits the line suffix when a finding has no line', () => {
    const md = formatReviewResponse({
      verdict: 'needs_review',
      summary: 'Check.',
      findings: [{ severity: 'low', file: 'src/a.ts', line: null, title: 'x', explanation: 'y', recommendation: 'z' }],
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
