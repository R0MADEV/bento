import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, createContextProvider } from '../../../src/core/ai/techReview'

describe('Tech Review', () => {
  it('builds a prompt with the diff and relevant context', () => {
    const prompt = buildReviewPrompt({
      diff: 'diff --git a/src/a.ts b/src/a.ts',
      files: [{ path: 'src/a.ts', content: 'export const a = 1' }],
      contextSources: ['direct'],
    })
    expect(prompt).toContain('diff --git')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('Markdown')
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
