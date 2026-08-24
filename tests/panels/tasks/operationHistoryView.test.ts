// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildOperationHistoryView } from '../../../src/panels/tasks/OperationHistoryView'
import { makeLocalStorage } from '../../helpers/localStorage'

describe('operation history view', () => {
  it('filters the branch, renders failures and exposes accessible controls', () => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    localStorage.setItem('bento.tasks.locale', 'es')
    const onBack = vi.fn()
    const onClear = vi.fn()
    const view = buildOperationHistoryView({
      branch: 'task/a', repository: '/repo', onBack, onClear,
      entries: [
        { id: '1', timestamp: 1, repository: '/repo', branch: 'task/a', operation: 'rebase', status: 'success', detail: 'ok' },
        { id: '2', timestamp: 2, repository: '/repo', branch: 'task/a', operation: 'push', status: 'error', detail: 'rechazado' },
        { id: '3', timestamp: 3, repository: '/repo', branch: 'task/b', operation: 'commit', status: 'success', detail: 'otro' },
      ],
    })
    expect(view.textContent).toContain('rebase')
    expect(view.textContent).toContain('rechazado')
    expect(view.textContent).not.toContain('otro')
    ;(view.querySelector('[aria-label="Volver a los cambios"]') as HTMLButtonElement).click()
    ;([...view.querySelectorAll('button')].find(button => button.textContent === 'Limpiar registro') as HTMLButtonElement).click()
    expect(onBack).toHaveBeenCalledOnce()
    expect(onClear).toHaveBeenCalledOnce()
  })
})
