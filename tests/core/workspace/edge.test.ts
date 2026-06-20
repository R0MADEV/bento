import { describe, it, expect } from 'vitest'
import { furthestEdgeIndex, type Edges } from '../../../src/core/workspace/edge'

const rect = (left: number, top: number, w = 100, h = 100): Edges => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
})

describe('furthestEdgeIndex', () => {
  const row = [rect(0, 0), rect(100, 0), rect(200, 0)] // A, B, C horizontal
  const col = [rect(0, 0), rect(0, 100), rect(0, 200)] // A, B, C vertical

  it('right → the rightmost group', () => {
    expect(furthestEdgeIndex(row, 'right')).toBe(2)
  })

  it('left → the leftmost group', () => {
    expect(furthestEdgeIndex(row, 'left')).toBe(0)
  })

  it('above → the topmost group', () => {
    expect(furthestEdgeIndex(col, 'above')).toBe(0)
  })

  it('below → the bottommost group', () => {
    expect(furthestEdgeIndex(col, 'below')).toBe(2)
  })

  it('no groups → -1', () => {
    expect(furthestEdgeIndex([], 'right')).toBe(-1)
  })

  it('single group → that one', () => {
    expect(furthestEdgeIndex([rect(0, 0)], 'left')).toBe(0)
  })
})
