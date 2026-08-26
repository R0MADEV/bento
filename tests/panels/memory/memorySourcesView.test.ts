// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  askConfirm: vi.fn(async () => true),
  pickFolder: vi.fn(async () => null as string | null),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.askConfirm, open: mocks.pickFolder }))

import { createMemorySourcesView } from '../../../src/panels/memory/memorySourcesView'
import type { MemorySource, ImportedMemoryCandidate } from '../../../src/core/memory/memorySource'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'
import type { MemoryRepository } from '../../../src/ports/MemoryRepository'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

const source = (over: Partial<MemorySource> = {}): MemorySource => ({
  id: 's1', projectPath: '/p', kind: 'filesystem', label: 'Notes', path: '/notes',
  createdAt: '', updatedAt: '', ...over,
})

const candidate = (over: Partial<ImportedMemoryCandidate> = {}): ImportedMemoryCandidate => ({
  title: 'A title', summary: 'a summary', details: '', source: 'claude',
  externalId: 'claude:1', createdAt: '2026-01-01T00:00:00.000Z', files: ['/Users/ana/bento/a.ts'], tags: [], ...over,
})

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'e1', projectPath: '/p', kind: 'note', title: 'A title', summary: 'a summary', details: '',
  source: 'claude', externalId: 'claude:old', tags: [], files: [], createdAt: '', updatedAt: '', ...over,
} as MemoryEntry)

let statuses: string[]
let imported: Array<string | null>

function repo(over: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    list: vi.fn(async () => [] as MemoryEntry[]),
    create: vi.fn(async (_p: string, e) => entry({ id: 'created', ...e } as Partial<MemoryEntry>)),
    update: vi.fn(async (_p: string, id: string) => entry({ id })),
    remove: vi.fn(async () => true),
    ...over,
  } as MemoryRepository
}

function view(over: { repo?: MemoryRepository; projectPath?: string } = {}) {
  const api = createMemorySourcesView({
    repo: over.repo ?? repo(),
    currentProject: over.projectPath ?? '/p',
    setStatus: m => { statuses.push(m ?? '') },
    onImported: async id => { imported.push(id) },
  })
  document.body.replaceChildren(api.element)
  return api
}

const q = <T extends Element>(sel: string): T => document.querySelector(sel) as T
const qa = (sel: string): Element[] => [...document.querySelectorAll(sel)]

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' })
  document.body.replaceChildren()
  statuses = []
  imported = []
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue([])
  mocks.askConfirm.mockReset()
  mocks.askConfirm.mockResolvedValue(true)
  mocks.pickFolder.mockReset()
  mocks.pickFolder.mockResolvedValue(null)
})

describe('the source list', () => {
  it('says there are none registered yet', async () => {
    view()
    await flush()
    expect(q('.memory-source-empty')).not.toBeNull()
  })

  it('shows each source with its label and path, and counts them in the title', async () => {
    mocks.invoke.mockResolvedValue([source(), source({ id: 's2', label: 'Codex', path: '/codex' })])
    view()
    await flush()
    expect(qa('.memory-source-item-text').map(e => e.textContent)).toEqual(['Notes', 'Codex'])
    expect(qa('.memory-source-item-path').map(e => e.textContent)).toEqual(['/notes', '/codex'])
    expect(q('.memory-sources-title').textContent).toContain('2')
  })

  it('lists nothing when the backend cannot be reached', async () => {
    mocks.invoke.mockRejectedValue(new Error('no backend'))
    view()
    await flush()
    expect(q('.memory-source-empty')).not.toBeNull()
  })

  it('scans a lone source on its own so the user sees something', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_source_list') return [source()]
      if (cmd === 'memory_source_scan') return [candidate()]
      return []
    })
    view()
    await flush()
    expect(qa('.memory-source-preview-item')).toHaveLength(1)
  })
})

describe('collapsing', () => {
  it('starts collapsed and remembers being opened', async () => {
    const api = view()
    await flush()
    expect(api.element.classList.contains('collapsed')).toBe(true)
    q<HTMLButtonElement>('.memory-sources-toggle').click()
    expect(api.element.classList.contains('collapsed')).toBe(false)
    expect(localStorage.getItem('bento.memory.sources.collapsed:/p')).toBe('0')
  })

  it('honours what was stored for this project', async () => {
    localStorage.setItem('bento.memory.sources.collapsed:/p', '0')
    const api = view()
    await flush()
    expect(api.element.classList.contains('collapsed')).toBe(false)
  })
})

describe('registering a source', () => {
  const path = (): HTMLInputElement => q('.memory-source-path, input[placeholder]')
  const inputs = (): HTMLInputElement[] => qa('input[type="text"], input:not([type])') as HTMLInputElement[]

  it('cannot be submitted without a path', async () => {
    view()
    await flush()
    const addBtn = qa('button').find(b => b.textContent === 'Add') as HTMLButtonElement | undefined
    expect(addBtn?.disabled ?? true).toBe(true)
  })

  it('defaults the label to the folder name as you type the path', async () => {
    view()
    await flush()
    const [label, pathInput] = inputs()
    pathInput.value = '/home/ana/notes'
    pathInput.dispatchEvent(new Event('input'))
    expect(label.value).toBe('notes')
    void path
  })
})

describe('scanning a source', () => {
  const setup = async (
    candidates: ImportedMemoryCandidate[],
    over: Partial<MemoryRepository> = {},
    decision: unknown = { action: 'create', payload: entry({ id: 'new' }) },
  ) => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_source_list') return [source(), source({ id: 's2' })]
      if (cmd === 'memory_source_scan') return candidates
      if (cmd === 'memory_plan_import') return decision
      return []
    })
    const api = view({ repo: repo(over) })
    await flush()
    ;(qa('.memory-source-item-actions button')[0] as HTMLButtonElement).click()
    await flush()
    return api
  }

  it('lists the candidates with their title, summary and project', async () => {
    await setup([candidate()])
    expect(q('.memory-source-preview-name').textContent).toBe('A title')
    expect(q('.memory-source-preview-summary').textContent).toBe('a summary')
    expect(q('.memory-source-preview-file').textContent).toBe('a.ts')
  })

  // Si un candidato ya está o se fundiría lo decide `bento_memory::dedup`.
  it('marks a candidate the planner would skip', async () => {
    await setup([candidate({ externalId: 'claude:1' })],
      { list: vi.fn(async () => [entry({ id: 'kept', externalId: 'claude:1' })]) },
      { action: 'skip', entryId: 'kept' })
    expect(q('.memory-source-preview-item').classList.contains('duplicate')).toBe(true)
    expect(q('.memory-source-preview-badge').classList.contains('existing')).toBe(true)
  })

  it('marks a candidate the planner would merge into an existing entry', async () => {
    await setup([candidate({ externalId: 'claude:new' })],
      { list: vi.fn(async () => [entry({ id: 'dup', externalId: 'claude:old' })]) },
      { action: 'merge', entry: entry({ id: 'dup' }), patch: { tags: [], files: [], summary: '', details: '' } })
    expect(q('.memory-source-preview-badge').classList.contains('merge')).toBe(true)
  })

  it('reports a failed scan and shows no candidates', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_source_list') return [source(), source({ id: 's2' })]
      if (cmd === 'memory_source_scan') throw new Error('folder is gone')
      return []
    })
    view()
    await flush()
    ;(qa('.memory-source-item-actions button')[0] as HTMLButtonElement).click()
    await flush()
    expect(statuses.join()).toContain('folder is gone')
    expect(qa('.memory-source-preview-item')).toHaveLength(0)
  })
})

describe('selecting candidates', () => {
  const setup = async (candidates: ImportedMemoryCandidate[]) => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_source_list') return [source()]
      if (cmd === 'memory_source_scan') return candidates
      return []
    })
    const api = view()
    await flush()
    return api
  }

  it('selects and clears every visible candidate', async () => {
    await setup([candidate({ externalId: 'a' }), candidate({ externalId: 'b' })])
    const checkboxes = (): HTMLInputElement[] => qa('.memory-source-preview-checkbox') as HTMLInputElement[]
    const [selectVisible, clearVisible] = qa('.memory-source-preview-actions button') as HTMLButtonElement[]
    expect(checkboxes().every(c => !c.checked)).toBe(true)

    selectVisible.click()
    expect(checkboxes().every(c => c.checked)).toBe(true)

    clearVisible.click()
    expect(checkboxes().every(c => !c.checked)).toBe(true)
  })

  it('filters the preview by project', async () => {
    await setup([
      candidate({ externalId: 'a', files: ['/Users/ana/one.ts'] }),
      candidate({ externalId: 'b', files: ['/Users/ana/two.ts'] }),
    ])
    const select = q<HTMLSelectElement>('select')
    expect([...select.options].map(o => o.value)).toEqual(['all', 'one.ts', 'two.ts'])
    select.value = 'one.ts'
    select.dispatchEvent(new Event('change'))
    expect(qa('.memory-source-preview-item')).toHaveLength(1)
  })
})

describe('importing the selection', () => {
  const setup = async (over: Partial<MemoryRepository> = {}) => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_source_list') return [source()]
      if (cmd === 'memory_source_scan') return [candidate({ externalId: 'a' })]
      return []
    })
    const api = view({ repo: repo(over) })
    await flush()
    return api
  }

  const importBtn = (): HTMLButtonElement =>
    qa('button').filter(b => (b.textContent ?? '').toLowerCase().includes('import')).at(-1) as HTMLButtonElement

  it('is disabled until something is checked', async () => {
    await setup()
    expect(importBtn().disabled).toBe(true)
    ;(q('.memory-source-preview-checkbox') as HTMLInputElement).checked = true
    q('.memory-source-preview-checkbox').dispatchEvent(new Event('change'))
    expect(importBtn().disabled).toBe(false)
  })

  it('imports what was checked and tells the panel which entry to reveal', async () => {
    const r = repo()
    await setup(r)
    const box = q<HTMLInputElement>('.memory-source-preview-checkbox')
    box.checked = true
    box.dispatchEvent(new Event('change'))
    importBtn().click()
    await flush()
    expect(r.create).toHaveBeenCalledTimes(1)
    expect(imported).toEqual(['created'])
  })
})

describe('removing a source', () => {
  const setup = async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => (cmd === 'memory_source_list' ? [source(), source({ id: 's2' })] : []))
    view()
    await flush()
  }

  const removeBtn = (): HTMLButtonElement => q('.memory-source-item-actions .danger')

  it('asks first and removes on confirmation', async () => {
    await setup()
    removeBtn().click()
    await flush()
    expect(mocks.askConfirm).toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'memory_source_remove')).toBe(true)
  })

  it('does nothing when the confirmation is refused', async () => {
    mocks.askConfirm.mockResolvedValue(false)
    await setup()
    removeBtn().click()
    await flush()
    expect(mocks.invoke.mock.calls.some(c => c[0] === 'memory_source_remove')).toBe(false)
  })
})
