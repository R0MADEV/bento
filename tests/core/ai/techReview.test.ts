import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => 'PROMPT') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildReviewPrompt, createContextProvider } from '../../../src/core/ai/techReview'

describe('Tech Review', () => {
  // El texto del prompt se comprueba en `daemon/bento-review/src/prompt.rs`;
  // aquí solo que el frontend le pasa lo que ha recogido.
  it('delegates the prompt to the shared Rust builder', async () => {
    await expect(buildReviewPrompt({
      project: 'bento',
      base: 'main',
      diff: 'diff --git a/src/a.ts b/src/a.ts',
      files: [{ path: 'src/a.ts', content: 'export const a = 1' }],
      contextSources: ['direct'],
    })).resolves.toBe('PROMPT')
    expect(mocks.invoke).toHaveBeenCalledWith('review_build_prompt', {
      input: expect.objectContaining({ project: 'bento', base: 'main', contextSources: ['direct'] }),
    })
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
