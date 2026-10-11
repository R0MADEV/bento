import { describe, it, expect } from 'vitest'
import { dimsChanged, gridToDraw, needsClaim } from '../../../src/core/terminal/dims'

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

// One terminal can be open in the app, the CLI and the phone at once. It has a
// single size, so each client draws at that one and asks for its own only when
// it is the one being used.
describe('needsClaim', () => {
  it('asks when the terminal is at another client size', () => {
    expect(needsClaim({ rows: 50, cols: 200 }, { rows: 24, cols: 80 })).toBe(true)
  })

  it('does not ask again for the size the terminal already has', () => {
    expect(needsClaim({ rows: 50, cols: 200 }, { rows: 50, cols: 200 })).toBe(false)
  })

  it('asks while the terminal size is still unknown', () => {
    expect(needsClaim({ rows: 50, cols: 200 }, null)).toBe(true)
  })

  it('never asks for a panel that has no size yet', () => {
    expect(needsClaim({ rows: 0, cols: 0 }, { rows: 24, cols: 80 })).toBe(false)
    expect(needsClaim({ rows: 0, cols: 0 }, null)).toBe(false)
  })
})

describe('gridToDraw', () => {
  it('draws at the size the terminal really has', () => {
    expect(gridToDraw({ rows: 50, cols: 200 }, { rows: 24, cols: 80 })).toEqual({ rows: 24, cols: 80 })
  })

  it('draws at its own size until the terminal reports one', () => {
    expect(gridToDraw({ rows: 50, cols: 200 }, null)).toEqual({ rows: 50, cols: 200 })
  })
})
