import { describe, expect, it } from 'vitest'
import { appendOperation, mapWithConcurrency, previewRebase, type RebasePlanItem } from '../../../src/core/git/rebaseWorkflow'

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
