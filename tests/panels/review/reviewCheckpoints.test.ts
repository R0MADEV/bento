import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { loadReviewCheckpoint } from '../../../src/panels/review/reviewCheckpoints'

describe('loadReviewCheckpoint', () => {
  it('prefers the shared store over the browser copy', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'review_checkpoint_get'
      ? { content: 'del disco', commit: 'abc1234', branch: 'feat/a', session_id: 's1', session_agent: 'codex' }
      : null))
    await expect(loadReviewCheckpoint('/repo', 'feat/a', JSON.stringify({ content: 'del navegador', commit: 'x', branch: 'feat/a' })))
      .resolves.toMatchObject({ content: 'del disco', commit: 'abc1234', sessionId: 's1', sessionAgent: 'codex' })
  })

  it('falls back to the browser copy for reviews saved before the move', async () => {
    mocks.invoke.mockImplementation(async () => null)
    await expect(loadReviewCheckpoint('/repo', 'feat/a', JSON.stringify({ content: 'del navegador', commit: 'x', branch: 'feat/a' })))
      .resolves.toMatchObject({ content: 'del navegador' })
  })

  it('returns null when neither has it', async () => {
    mocks.invoke.mockImplementation(async () => null)
    await expect(loadReviewCheckpoint('/repo', 'feat/a', null)).resolves.toBeNull()
  })
})
