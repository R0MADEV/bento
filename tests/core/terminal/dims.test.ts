import { describe, it, expect } from 'vitest'
import { dimsChanged } from '../../../src/core/terminal/dims'

describe('dimsChanged', () => {
  it('same dimensions → false', () => {
    expect(dimsChanged({ rows: 24, cols: 80 }, { rows: 24, cols: 80 })).toBe(false)
  })

  it('rows change → true', () => {
    expect(dimsChanged({ rows: 24, cols: 80 }, { rows: 30, cols: 80 })).toBe(true)
  })

  it('cols change → true', () => {
    expect(dimsChanged({ rows: 24, cols: 80 }, { rows: 24, cols: 120 })).toBe(true)
  })

  it('both change → true', () => {
    expect(dimsChanged({ rows: 24, cols: 80 }, { rows: 30, cols: 120 })).toBe(true)
  })
})
