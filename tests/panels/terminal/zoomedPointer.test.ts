import { describe, expect, it } from 'vitest'
import { unzoomedCoordinate } from '../../../src/panels/terminal/zoomedPointer'

describe('unzoomedCoordinate', () => {
  it('leaves the pointer where it is without zoom', () => {
    expect(unzoomedCoordinate(755, 20, 1)).toBe(755)
  })

  // At 110% a pointer 770px into the terminal is over the cell drawn at 700
  // layout pixels: reading it as 770 selected text a tenth further away.
  it('undoes the zoom from the terminal corner', () => {
    expect(unzoomedCoordinate(20 + 770, 20, 1.1)).toBeCloseTo(20 + 700)
  })

  it('keeps the corner itself in place', () => {
    expect(unzoomedCoordinate(20, 20, 1.5)).toBe(20)
  })
})
