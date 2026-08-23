// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import { createMemoryListView } from '../../../src/panels/memory/memoryListView'
import {
  MEMORY_ARCHIVED_TAG, MEMORY_PINNED_TAG, MEMORY_VERIFIED_TAG,
} from '../../../src/core/memory/normalize'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'e1', projectPath: '/p', kind: 'note', title: 'A title', summary: 'a summary', details: '',
  source: 'manual', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

function setup(over: { rows?: MemoryEntry[]; selectedId?: string | null; currentProject?: string } = {}) {
  const state = {
    selectedId: over.selectedId ?? null as string | null,
    selectedIds: new Set<string>(),
    miniItems: [] as Array<{ label: string; active: boolean; onClick: () => void }>,
    selections: [] as Array<MemoryEntry | undefined>,
    bulkSyncs: 0,
  }
  const view = createMemoryListView({
    currentProject: over.currentProject ?? '/p',
    getVisibleRows: () => over.rows ?? [entry()],
    getSelectedId: () => state.selectedId,
    selectedIds: state.selectedIds,
    setMiniItems: items => { state.miniItems = items },
    onSelect: e => { state.selectedId = e.id; state.selections.push(e) },
    onSelectionChanged: () => { state.bulkSyncs++ },
  })
  document.body.replaceChildren(view.element)
  view.render()
  return { view, state }
}

const items = (): HTMLElement[] => [...document.querySelectorAll('.memory-item')] as HTMLElement[]
const q = <T extends Element>(sel: string): T => document.querySelector(sel) as T

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
})

describe('the empty state', () => {
  it('says nothing matches the filter', () => {
    setup({ rows: [] })
    expect(q('.memory-empty')).not.toBeNull()
    expect(items()).toHaveLength(0)
  })

  it('clears the mini list too', () => {
    const { state } = setup({ rows: [] })
    expect(state.miniItems).toEqual([])
  })
})

describe('rendering rows', () => {
  it('shows the kind, title and source of each entry', () => {
    setup({ rows: [entry({ kind: 'decision', title: 'Chose SQLite', source: 'claude' })] })
    expect(q('.memory-kind').textContent).toBeTruthy()
    expect(q('.memory-item-title').textContent).toBe('Chose SQLite')
    expect(q('.memory-source').textContent).toBe('claude')
  })

  it('falls back to a placeholder title and summary', () => {
    setup({ rows: [entry({ title: '', summary: '', details: '' })] })
    expect(q('.memory-item-title').textContent).not.toBe('')
    expect(q('.memory-item-summary').textContent).not.toBe('')
  })

  it('shows the details when there is no summary', () => {
    setup({ rows: [entry({ summary: '', details: 'the details' })] })
    expect(q('.memory-item-summary').textContent).toBe('the details')
  })

  it('prefixes the project when browsing memory globally', () => {
    setup({ currentProject: '', rows: [entry({ projectPath: '/home/ana/bento' })] })
    expect(q('.memory-item-summary').textContent).toContain('/home/ana/bento')
  })

  it('marks pinned, verified and archived entries', () => {
    setup({ rows: [
      entry({ id: 'a', tags: [MEMORY_PINNED_TAG] }),
      entry({ id: 'b', tags: [MEMORY_VERIFIED_TAG] }),
      entry({ id: 'c', tags: [MEMORY_ARCHIVED_TAG] }),
    ] })
    expect(items()[0].classList.contains('pinned')).toBe(true)
    expect(items()[1].classList.contains('verified')).toBe(true)
    expect(items()[2].classList.contains('archived')).toBe(true)
  })

  it('highlights the open entry', () => {
    setup({ rows: [entry({ id: 'a' }), entry({ id: 'b' })], selectedId: 'b' })
    expect(items().map(i => i.classList.contains('active'))).toEqual([false, true])
  })

  it('replaces the rows instead of appending on a re-render', () => {
    const { view } = setup({ rows: [entry()] })
    view.render()
    expect(items()).toHaveLength(1)
  })
})

describe('opening an entry', () => {
  it('reports the clicked entry', () => {
    const { state } = setup({ rows: [entry({ id: 'a' }), entry({ id: 'b' })] })
    items()[1].click()
    expect(state.selections.at(-1)?.id).toBe('b')
  })

  it('re-renders so the highlight moves', () => {
    setup({ rows: [entry({ id: 'a' }), entry({ id: 'b' })] })
    items()[1].click()
    expect(items()[1].classList.contains('active')).toBe(true)
  })
})

describe('the multi-selection', () => {
  const boxes = (): HTMLInputElement[] =>
    [...document.querySelectorAll('.memory-item input[type="checkbox"]')] as HTMLInputElement[]

  it('reflects what is already selected', () => {
    const { state, view } = setup({ rows: [entry({ id: 'a' }), entry({ id: 'b' })] })
    state.selectedIds.add('b')
    view.render()
    expect(boxes().map(b => b.checked)).toEqual([false, true])
  })

  it('adds and removes on tick, telling the panel each time', () => {
    const { state } = setup({ rows: [entry({ id: 'a' })] })
    const box = boxes()[0]
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect([...state.selectedIds]).toEqual(['a'])
    expect(state.bulkSyncs).toBe(1)

    box.checked = false
    box.dispatchEvent(new Event('change'))
    expect(state.selectedIds.size).toBe(0)
    expect(state.bulkSyncs).toBe(2)
  })

  it('does not open the entry when only the checkbox is clicked', () => {
    const { state } = setup({ rows: [entry({ id: 'a' })] })
    boxes()[0].click()
    expect(state.selections).toHaveLength(0)
  })
})

describe('the mini list', () => {
  it('mirrors the rows and marks the open one', () => {
    const { state } = setup({ rows: [entry({ id: 'a', title: 'One' }), entry({ id: 'b', title: 'Two' })], selectedId: 'b' })
    expect(state.miniItems.map(i => i.label)).toEqual(['One', 'Two'])
    expect(state.miniItems.map(i => i.active)).toEqual([false, true])
  })

  it('opens an entry when its mini item is clicked', () => {
    const { state } = setup({ rows: [entry({ id: 'a' })] })
    state.miniItems[0].onClick()
    expect(state.selections.at(-1)?.id).toBe('a')
  })
})
