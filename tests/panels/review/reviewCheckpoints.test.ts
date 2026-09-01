import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { deleteReviewCheckpoint, listReviewCheckpoints, loadReviewCheckpoint } from '../../../src/panels/review/reviewCheckpoints'

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

describe('el historial guardado', () => {
  it('lista las reviews del proyecto, no las de la rama', async () => {
    // Una review corrida desde la TUI se archiva bajo la base y otra desde el
    // escritorio bajo la rama: por proyecto salen las dos.
    const metas = [{ base: 'main', saved_at: '2026-08-27T09:00:00Z', resumable: true }]
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'review_checkpoints_list' ? metas : null))

    await expect(listReviewCheckpoints('/repo')).resolves.toEqual(metas)
  })

  it('devuelve una lista vacía si el comando falla, en vez de romper el panel', async () => {
    mocks.invoke.mockImplementation(async () => { throw new Error('sin daemon') })

    await expect(listReviewCheckpoints('/repo')).resolves.toEqual([])
  })

  it('abre el run que le pides, no el más nuevo de la rama', async () => {
    const calls: unknown[] = []
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push(args)
      return cmd === 'review_checkpoint_get' ? { content: 'ese run', commit: 'abc1234', branch: 'feat/a' } : null
    })

    await expect(loadReviewCheckpoint('/repo', 'feat/a', null, 'run-2'))
      .resolves.toMatchObject({ content: 'ese run' })
    expect(calls[0]).toMatchObject({ cwd: '/repo', base: 'feat/a', runId: 'run-2' })
  })

  it('borra nombrando el run, que es lo que alcanza al fichero', async () => {
    const calls: unknown[] = []
    mocks.invoke.mockImplementation(async (_cmd: string, args?: unknown) => { calls.push(args); return null })

    await deleteReviewCheckpoint('/repo', 'main', 'run-2')

    expect(calls[0]).toMatchObject({ cwd: '/repo', base: 'main', runId: 'run-2' })
  })
})
