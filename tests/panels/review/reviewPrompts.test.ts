import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => 'PROMPT') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildReviewPrompt, buildReviewSynthesisPrompt } from '../../../src/panels/review/reviewPrompts'

// El texto de los prompts se comprueba en `daemon/bento-review/src/prompt.rs`;
// aquí solo que el frontend le pasa lo que ha recogido.
describe('review prompts', () => {
  it('delegates the review prompt to the shared Rust builder', async () => {
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

  it('forwards the base prompt and every reviewer report to the shared builder', async () => {
    const reports = [{ label: 'Claude', report: 'Hallazgo A' }, { label: 'Codex', report: 'Hallazgo B' }]
    await expect(buildReviewSynthesisPrompt('BASE PROMPT', reports)).resolves.toBe('PROMPT')
    expect(mocks.invoke).toHaveBeenCalledWith('review_build_synthesis_prompt', { basePrompt: 'BASE PROMPT', reports })
  })
})
