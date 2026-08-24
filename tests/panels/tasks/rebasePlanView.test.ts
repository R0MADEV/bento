// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildRebasePlanPreview } from '../../../src/panels/tasks/RebasePlanView'
import { makeLocalStorage } from '../../helpers/localStorage'

describe('rebase plan view', () => {
  it('renders the resulting commit count and integration target', () => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    localStorage.setItem('bento.tasks.locale', 'en')
    const view = buildRebasePlanPreview([
      { action: 'pick', hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'base' },
      { action: 'fixup', hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'fix' },
    ])
    expect(view.textContent).toContain('Expected result: 1 commits')
    expect(view.textContent).toContain('bbbbbbb → aaaaaaa')
  })
})
