import { describe, expect, it } from 'vitest'
import { toLayoutPixels } from '../../../src/ui/helpers/zoom'

describe('toLayoutPixels', () => {
  it('converts viewport coordinates to coordinates inside a zoomed document', () => {
    expect(toLayoutPixels(300, 1.5)).toBe(200)
  })

  it('leaves coordinates unchanged at the default zoom', () => {
    expect(toLayoutPixels(300, 1)).toBe(300)
  })
})
