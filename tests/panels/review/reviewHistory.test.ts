// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { buildReviewHistory, formatCheckpointRow } from '../../../src/panels/review/reviewHistory'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
}

const meta = (over: Record<string, unknown> = {}) => ({
  base: 'main', saved_at: '2026-08-27T09:05:00Z', branch: 'feat/x', run_id: 'run-1', resumable: true, ...over,
})

describe('el historial de reviews del escritorio', () => {
  it('lee cada review por cuándo se hizo y de qué es', () => {
    setup()
    expect(formatCheckpointRow(meta())).toBe('27/08 09:05 · feat/x')
  })

  it('cae a la clave cuando la review no nombra rama', () => {
    setup()
    expect(formatCheckpointRow(meta({ branch: null }))).toBe('27/08 09:05 · main')
  })

  it('deja la fecha como está si no tiene la forma que escribe el almacén', () => {
    setup()
    expect(formatCheckpointRow(meta({ saved_at: 'hace un rato' }))).toBe('hace un rato · feat/x')
  })

  it('abre la review que pulsas, no la última de la rama', () => {
    setup()
    const onOpen = vi.fn()
    const list = buildReviewHistory([meta({ run_id: 'run-1' }), meta({ run_id: 'run-2' })], { onOpen, onDelete: vi.fn() })

    list.querySelectorAll<HTMLButtonElement>('.review-history-open')[1]?.click()

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'run-2' }))
  })

  it('dice cuáles se pueden seguir preguntando', () => {
    setup()
    const list = buildReviewHistory([meta({ resumable: false })], { onOpen: vi.fn(), onDelete: vi.fn() })

    // Listar como resumible una que no lo es es peor que decirlo.
    expect(list.querySelector('.review-history-resumable')).toBeNull()
    expect(buildReviewHistory([meta()], { onOpen: vi.fn(), onDelete: vi.fn() })
      .querySelector('.review-history-resumable')).not.toBeNull()
  })

  it('borra la que pulsas', () => {
    setup()
    const onDelete = vi.fn()
    const list = buildReviewHistory([meta({ run_id: 'run-1' })], { onOpen: vi.fn(), onDelete })

    list.querySelector<HTMLButtonElement>('.review-history-delete')!.click()

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'run-1' }))
  })

  it('sin reviews guardadas lo dice en vez de dejar el hueco vacío', () => {
    setup()
    const list = buildReviewHistory([], { onOpen: vi.fn(), onDelete: vi.fn() })

    expect(list.textContent).toContain('No saved review')
  })
})
