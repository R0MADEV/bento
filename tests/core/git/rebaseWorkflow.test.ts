import { describe, expect, it } from 'vitest'
import { appendOperation, mapWithConcurrency, previewRebase, type RebasePlanItem, reorderByDrop, swapItems } from '../../../src/core/git/rebaseWorkflow'

const item = (short: string, action: RebasePlanItem['action'] = 'pick'): RebasePlanItem => ({
  action, hash: short.padEnd(40, '0'), short, subject: `Commit ${short}`,
})

describe('previewRebase', () => {
  it('describes dropped, edited and combined commits', () => {
    const preview = previewRebase([item('aaaaaaa'), item('bbbbbbb', 'fixup'), item('ccccccc', 'reword'), item('ddddddd', 'drop')])
    expect(preview).toMatchObject({ resultingCommits: 2, combinedCommits: 1, droppedCommits: 1, editedCommits: 1 })
    expect(preview.lines[1]).toContain('bbbbbbb → aaaaaaa')
  })

  it('warns when a fixup has no destination', () => {
    expect(previewRebase([item('aaaaaaa', 'fixup')]).warnings[0]).toContain('no tiene')
  })
})

describe('operation history', () => {
  it('keeps newest entries first and applies the limit', () => {
    let entries = appendOperation([], { repository: '/repo', branch: 'task', operation: 'rebase', status: 'success', detail: 'ok' }, 1, 2)
    entries = appendOperation(entries, { repository: '/repo', branch: 'task', operation: 'push', status: 'error', detail: 'no' }, 2, 2)
    entries = appendOperation(entries, { repository: '/repo', branch: 'task', operation: 'fixup', status: 'success', detail: 'ok' }, 3, 2)
    expect(entries.map(entry => entry.operation)).toEqual(['fixup', 'push'])
  })
})

describe('mapWithConcurrency', () => {
  it('preserves order while limiting active workers', async () => {
    let active = 0
    let maximum = 0
    const result = await mapWithConcurrency([3, 1, 2, 4], 2, async value => {
      active++; maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return value * 2
    })
    expect(result).toEqual([6, 2, 4, 8])
    expect(maximum).toBeLessThanOrEqual(2)
  })
})

describe('reorderByDrop', () => {
  const list = (): string[] => ['a', 'b', 'c', 'd']

  it('moves an item down, landing after the drop target', () => {
    expect(reorderByDrop(list(), 0, 2, true)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an item down, landing before the drop target', () => {
    expect(reorderByDrop(list(), 0, 2, false)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves an item up, landing before the drop target', () => {
    expect(reorderByDrop(list(), 3, 1, false)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves an item up, landing after the drop target', () => {
    expect(reorderByDrop(list(), 3, 1, true)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('leaves the list alone when the item lands where it already was', () => {
    expect(reorderByDrop(list(), 1, 0, true)).toEqual(list())
    expect(reorderByDrop(list(), 1, 2, false)).toEqual(list())
  })

  it('handles the ends: first to last and last to first', () => {
    expect(reorderByDrop(list(), 0, 3, true)).toEqual(['b', 'c', 'd', 'a'])
    expect(reorderByDrop(list(), 3, 0, false)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('does not touch the array it was given', () => {
    const original = list()
    reorderByDrop(original, 0, 3, true)
    expect(original).toEqual(list())
  })
})

describe('swapItems', () => {
  it('swaps two positions', () => {
    expect(swapItems(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
  })

  it('is its own inverse', () => {
    expect(swapItems(swapItems(['a', 'b', 'c'], 0, 2), 0, 2)).toEqual(['a', 'b', 'c'])
  })

  it('leaves the list alone for an out-of-range position', () => {
    expect(swapItems(['a', 'b'], 0, 2)).toEqual(['a', 'b'])
    expect(swapItems(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
  })

  it('does not touch the array it was given', () => {
    const original = ['a', 'b']
    swapItems(original, 0, 1)
    expect(original).toEqual(['a', 'b'])
  })
})
