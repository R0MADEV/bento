import { describe, expect, it } from 'vitest'
import { createContextProvider } from '../../../src/core/ai/techReview'

describe('Tech Review context', () => {
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
