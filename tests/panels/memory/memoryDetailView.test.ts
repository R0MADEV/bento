// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  askAi: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../src/ui/askAi', () => ({ askAi: mocks.askAi }))

import { createMemoryDetailView } from '../../../src/panels/memory/memoryDetailView'
import {
  MEMORY_PINNED_TAG, MEMORY_VERIFIED_TAG, MEMORY_SUPERSEDED_TAG,
} from '../../../src/core/memory/normalize'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'
import type { MemoryRepository } from '../../../src/ports/MemoryRepository'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'e1', projectPath: '/p', kind: 'decision', title: 'A title', summary: 'a summary',
  details: 'the details', source: 'manual', externalId: '', tags: [], files: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...over,
} as MemoryEntry)

function repo(over: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async () => entry({ id: 'created' })),
    update: vi.fn(async (_p: string, id: string) => entry({ id })),
    remove: vi.fn(async () => true),
    ...over,
  } as MemoryRepository
}

function setup(over: { repo?: MemoryRepository; currentProject?: string; open?: MemoryEntry } = {}) {
  const state = {
    selectedId: over.open?.id ?? null as string | null,
    reloads: 0,
    archived: [] as MemoryEntry[][],
    deleted: [] as MemoryEntry[][],
    toggled: [] as string[],
  }
  const r = over.repo ?? repo()
  const view = createMemoryDetailView({
    repo: r,
    currentProject: over.currentProject ?? '/p',
    getSelectedEntry: () => over.open,
    getSelectedId: () => state.selectedId,
    setSelectedId: id => { state.selectedId = id },
    reload: async () => { state.reloads++ },
    actions: {
      archiveEntries: async rows => { state.archived.push(rows) },
      deleteEntries: async rows => { state.deleted.push(rows) },
      toggleSelectedTag: async tag => { state.toggled.push(tag) },
      mergeSelected: async () => {},
    },
  })
  document.body.replaceChildren(view.element)
  view.fill(over.open)
  return { view, state, repo: r }
}

const q = <T extends Element>(sel: string): T => document.querySelector(sel) as T
const btn = (title: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')]
    .find(b => (b.title ?? '').toLowerCase().includes(title.toLowerCase())) as HTMLButtonElement
// The kind <select> also carries .memory-input; the text fields are the inputs.
const fields = (): HTMLInputElement[] => [...document.querySelectorAll('input.memory-input')] as HTMLInputElement[]
const areas = (): HTMLTextAreaElement[] => [...document.querySelectorAll('.memory-textarea')] as HTMLTextAreaElement[]

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(null)
  mocks.askAi.mockReset()
})

describe('filling the form', () => {
  it('shows the open entry in every field', () => {
    setup({ open: entry({ tags: ['a', 'b'], files: ['x.ts'] }) })
    const [source, title, tags, files] = fields()
    expect(q<HTMLSelectElement>('select').value).toBe('decision')
    expect(source.value).toBe('manual')
    expect(title.value).toBe('A title')
    expect(tags.value).toBe('a, b')
    expect(files.value).toBe('x.ts')
    expect(areas().map(a => a.value)).toEqual(['a summary', 'the details'])
  })

  it('clears to a blank decision when nothing is open', () => {
    setup()
    expect(q<HTMLSelectElement>('select').value).toBe('decision')
    expect(fields().map(f => f.value)).toEqual(['manual', '', '', ''])
  })

  it('disables every entry action when nothing is open', () => {
    setup()
    expect(btn('Archive entry').disabled).toBe(true)
    expect(btn('Delete entry').disabled).toBe(true)
  })

  it('names the pin, verify and obsolete buttons after the current state', () => {
    setup({ open: entry() })
    const plain = [btn('prioritized').textContent, btn('reviewed').textContent, btn('obsolete').textContent]
    setup({ open: entry({ tags: [MEMORY_PINNED_TAG, MEMORY_VERIFIED_TAG, MEMORY_SUPERSEDED_TAG] }) })
    const tagged = [btn('prioritized').textContent, btn('reviewed').textContent, btn('obsolete').textContent]
    expect(tagged).not.toEqual(plain)
  })

  it('only offers regenerate for a session summary', () => {
    setup({ open: entry() })
    expect(btn('Regenerate summary').disabled).toBe(true)
    setup({ open: entry({ externalId: 'claude:session-summary:x' }) })
    expect(btn('Regenerate summary').disabled).toBe(false)
  })
})

describe('focusTitle', () => {
  it('puts the cursor in the title field, for a brand new entry', () => {
    const { view } = setup()
    view.focusTitle()
    expect(document.activeElement).toBe(fields()[1])
  })
})

describe('the status line', () => {
  it('describes the open entry by kind, source and time', () => {
    setup({ open: entry() })
    const text = q('.memory-status').textContent ?? ''
    expect(text).toContain('manual')
  })

  it('names the project when nothing is open', () => {
    setup({ currentProject: '/home/ana/bento' })
    expect(q('.memory-status').textContent).toContain('/home/ana/bento')
  })

  it('shows an explicit message over the description', () => {
    const { view } = setup({ open: entry() })
    view.setStatus('something happened')
    expect(q('.memory-status').textContent).toBe('something happened')
  })
})

describe('saving', () => {
  const fill = (title: string): void => {
    const [, titleInput] = fields()
    titleInput.value = title
  }

  it('does nothing when title, summary and details are all empty', async () => {
    const { repo: r } = setup()
    q<HTMLButtonElement>('.memory-primary').click()
    await flush()
    expect(r.create).not.toHaveBeenCalled()
  })

  it('creates a new entry when none is open', async () => {
    const { repo: r, state } = setup()
    fill('New memory')
    q<HTMLButtonElement>('.memory-primary').click()
    await flush()
    expect(r.create).toHaveBeenCalledTimes(1)
    expect(state.selectedId).toBe('created')
    expect(state.reloads).toBe(1)
  })

  it('updates the open entry instead of creating another', async () => {
    const { repo: r } = setup({ open: entry({ id: 'e1' }) })
    fill('Edited')
    q<HTMLButtonElement>('.memory-primary').click()
    await flush()
    expect(r.update).toHaveBeenCalledTimes(1)
    expect(r.create).not.toHaveBeenCalled()
  })

  it('splits tags and files into lists', async () => {
    const { repo: r } = setup()
    const [, title, tags, files] = fields()
    title.value = 'T'
    tags.value = 'a, b ,a'
    files.value = 'x.ts, y.ts'
    q<HTMLButtonElement>('.memory-primary').click()
    await flush()
    const payload = (r.create as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(payload.tags).toEqual(['a', 'b'])
    expect(payload.files).toEqual(['x.ts', 'y.ts'])
  })

  it('defaults an empty source to manual', async () => {
    const { repo: r } = setup()
    const [source, title] = fields()
    source.value = '   '
    title.value = 'T'
    q<HTMLButtonElement>('.memory-primary').click()
    await flush()
    expect((r.create as ReturnType<typeof vi.fn>).mock.calls[0][1].source).toBe('manual')
  })

  it('reports a failure and leaves the button usable', async () => {
    const { repo: r, view } = setup({ repo: repo({ create: vi.fn(async () => { throw new Error('disk full') }) }) })
    void r
    fields()[1].value = 'T'
    const save = q<HTMLButtonElement>('.memory-primary')
    save.click()
    await flush()
    expect(q('.memory-status').textContent).toContain('disk full')
    expect(save.disabled).toBe(false)
    void view
  })
})

describe('the entry buttons', () => {
  it('archive and delete act on the open entry', async () => {
    const open = entry()
    const { state } = setup({ open })
    btn('Archive entry').click()
    btn('Delete entry').click()
    await flush()
    expect(state.archived).toEqual([[open]])
    expect(state.deleted).toEqual([[open]])
  })

  it('pin, verify and obsolete toggle their tag', async () => {
    const { state } = setup({ open: entry() })
    btn('prioritized').click()
    btn('reviewed').click()
    btn('obsolete').click()
    await flush()
    expect(state.toggled).toEqual([MEMORY_PINNED_TAG, MEMORY_VERIFIED_TAG, MEMORY_SUPERSEDED_TAG])
  })
})

describe('regenerating a summary', () => {
  const summaryEntry = entry({ externalId: 'claude:session-summary:s1' })

  it('does nothing for an entry that is not a session summary', async () => {
    setup({ open: entry() })
    btn('Regenerate summary').click()
    await flush()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('asks the backend and selects what comes back', async () => {
    mocks.invoke.mockResolvedValue(entry({ id: 'fresh' }))
    const { state } = setup({ open: summaryEntry })
    btn('Regenerate summary').click()
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('memory_regenerate_summary', {
      projectPath: '/p', externalId: 'claude:session-summary:s1',
    })
    expect(state.selectedId).toBe('fresh')
    expect(state.reloads).toBe(1)
  })

  it('says so when there was nothing to regenerate, without reloading', async () => {
    mocks.invoke.mockResolvedValue(null)
    const { state } = setup({ open: summaryEntry })
    btn('Regenerate summary').click()
    await flush()
    expect(state.reloads).toBe(0)
    expect(q('.memory-status').textContent).not.toBe('')
  })

  it('reports a failure', async () => {
    mocks.invoke.mockRejectedValue(new Error('transcript missing'))
    setup({ open: summaryEntry })
    btn('Regenerate summary').click()
    await flush()
    expect(q('.memory-status').textContent).toContain('transcript missing')
  })
})

describe('sending to the AI chat', () => {
  it('does nothing when no entry is open', () => {
    setup()
    btn('Send to AI chat').click()
    expect(mocks.askAi).not.toHaveBeenCalled()
  })

  it('sends the whole entry with its project', () => {
    setup({ currentProject: '/home/ana/bento', open: entry({ tags: ['x'], files: ['a.ts'] }) })
    btn('Send to AI chat').click()
    const sent = mocks.askAi.mock.calls[0][0] as string
    expect(sent).toContain('/home/ana/bento')
    expect(sent).toContain('A title')
    expect(sent).toContain('a summary')
    expect(sent).toContain('the details')
    expect(sent).toContain('x')
    expect(sent).toContain('a.ts')
  })
})
