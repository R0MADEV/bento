// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildFileDiffRenderers } from '../../../src/panels/review/reviewFileDiff'

const DIFF = [
  '@@ -1,3 +1,4 @@',
  ' const sin = 1',
  '-const viejo = 2',
  '+const nuevo = 2',
  '+const extra = 3',
].join('\n')

function setup() {
  const makeLineForm = vi.fn(() => document.createElement('form'))
  const start = vi.fn()
  const createLineRangeSelector = vi.fn(() => ({ start }))
  const renderers = buildFileDiffRenderers({ makeLineForm, createLineRangeSelector })
  return { renderers, makeLineForm, createLineRangeSelector }
}

describe('file diff renderers', () => {
  it('marks added and removed lines in the unified view', () => {
    const { renderers } = setup()
    const el = renderers.buildFileDiff(DIFF, 'src/a.ts')
    expect(el.querySelectorAll('.tasks-diff-line-add')).toHaveLength(2)
    expect(el.querySelectorAll('.tasks-diff-line-del')).toHaveLength(1)
  })

  it('keeps the file path on the container so a comment knows where it goes', () => {
    const { renderers } = setup()
    expect(renderers.buildFileDiff(DIFF, 'src/a.ts').dataset.filepath).toBe('src/a.ts')
    expect(renderers.buildFileDiffSideBySide(DIFF, 'src/a.ts').dataset.filepath).toBe('src/a.ts')
  })

  it('numbers the lines of the new file, not of the diff', () => {
    const { renderers } = setup()
    const lines = [...renderers.buildFileDiff(DIFF, 'src/a.ts').querySelectorAll<HTMLElement>('[data-line]')]
    expect(lines.map(l => l.dataset.line)).toEqual(['1', '2', '3'])
  })

  it('splits both sides in the side-by-side view', () => {
    const { renderers } = setup()
    const el = renderers.buildFileDiffSideBySide(DIFF, 'src/a.ts')
    expect(el.querySelectorAll('.review-split-row').length).toBeGreaterThan(0)
  })

  it('wires drag-to-select in both views', () => {
    const { renderers, createLineRangeSelector } = setup()
    renderers.buildFileDiff(DIFF, 'src/a.ts')
    renderers.buildFileDiffSideBySide(DIFF, 'src/a.ts')
    expect(createLineRangeSelector).toHaveBeenCalledTimes(2)
  })

  it('renders an empty diff without throwing', () => {
    const { renderers } = setup()
    expect(renderers.buildFileDiff('', 'src/a.ts').querySelectorAll('.tasks-diff-line-add')).toHaveLength(0)
  })
})
