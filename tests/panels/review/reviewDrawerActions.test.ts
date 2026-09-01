// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => null as unknown), askAi: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../src/ui/askAi', () => ({ askAi: mocks.askAi }))

import { buildReviewDrawerActions } from '../../../src/panels/review/reviewDrawerActions'

const SAVED = {
  content: '# Hallazgos', commit: 'abc1234567', branch: 'feat/x',
  session_id: null, session_agent: null,
}

function setup(over: { head?: string } = {}) {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'review_checkpoint_get') return SAVED
    if (cmd === 'git_rev_parse') return over.head ?? 'abc1234567'
    return null
  })
  const dom = {
    reviewDrawer: document.createElement('aside'),
    reviewDrawerMeta: document.createElement('span'),
    reviewDrawerBody: document.createElement('div'),
    diffView: document.createElement('div'),
  }
  const actions = buildReviewDrawerActions(dom, {
    getRepoPath: () => '/repo',
    getSelectedBranch: () => 'feat/x',
  })
  return { dom, actions }
}

describe('reabrir una review guardada', () => {
  beforeEach(() => { mocks.askAi.mockReset() })

  it('avisa de que la rama se movió desde que se hizo', async () => {
    const { dom, actions } = setup({ head: 'def7654321' })

    await actions.openSavedReview()

    // El informe se pinta ya; el aviso entra cuando se resuelve el sha, para
    // no hacer esperar a la lectura por una llamada a git.
    await vi.waitFor(() =>
      expect(dom.reviewDrawerBody.querySelector('.review-stale')?.textContent).toContain('abc1234'))
  })

  it('no avisa cuando la review es del commit que hay', async () => {
    const { dom, actions } = setup({ head: 'abc1234567' })

    await actions.openSavedReview()

    expect(dom.reviewDrawerBody.querySelector('.review-stale')).toBeNull()
    expect(dom.reviewDrawerBody.textContent).toContain('Hallazgos')
  })
})
