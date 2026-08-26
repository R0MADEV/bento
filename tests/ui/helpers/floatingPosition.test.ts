import { describe, expect, it } from 'vitest'
import { clampToViewport } from '../../../src/ui/helpers/floatingPosition'

const viewport = { width: 1000, height: 800 }

describe('clampToViewport', () => {
  it('leaves a position that already fits', () => {
    expect(clampToViewport({ x: 100, y: 100 }, { width: 460, height: 320 }, viewport)).toEqual({ x: 100, y: 100 })
  })

  it('pulls back a window dragged past the right edge', () => {
    expect(clampToViewport({ x: 9000, y: 0 }, { width: 460, height: 320 }, viewport).x).toBe(1000 - 460 - 16)
  })

  it('keeps a sliver on screen when dragged off the left', () => {
    // -16 y no 0: se permite asomar un poco, pero nunca perderlo del todo.
    expect(clampToViewport({ x: -9000, y: 0 }, { width: 460, height: 320 }, viewport).x).toBe(-16)
  })

  it('clamps vertically against the viewport too', () => {
    expect(clampToViewport({ x: 0, y: 9000 }, { width: 460, height: 320 }, viewport).y).toBe(800 - 320 - 32)
  })

  it('still returns something usable when the window is taller than the viewport', () => {
    // Con una ventana más alta que la pantalla el margen inferior es negativo:
    // el mínimo tiene que ganar al máximo, no al revés, o saldría fuera.
    const pos = clampToViewport({ x: 0, y: 0 }, { width: 460, height: 900 }, viewport)
    expect(pos.y).toBeLessThanOrEqual(16)
  })
})
