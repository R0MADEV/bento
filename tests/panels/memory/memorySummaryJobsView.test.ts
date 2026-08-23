// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createMemorySummaryJobsView } from '../../../src/panels/memory/memorySummaryJobsView'
import type { MemorySummaryJob } from '../../../src/core/memory/memorySource'
import type { MemoryEntry } from '../../../src/core/memory/MemoryEntry'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

const job = (over: Partial<MemorySummaryJob> = {}): MemorySummaryJob => ({
  id: 'j1', projectPath: '/home/ana/bento', agent: 'claude', sessionId: 's1',
  transcriptExternalId: 't1', transcriptHash: 'h', status: 'pending', error: '',
  attempts: 0, metadataJson: '', createdAt: '', updatedAt: '', ...over,
})

let statuses: Array<{ message?: string; entry?: MemoryEntry }>
let regenerated: Array<MemoryEntry | null>

function view() {
  const api = createMemorySummaryJobsView({
    currentProject: '/home/ana/bento',
    setStatus: (message, entry) => { statuses.push({ message, entry }) },
    onRegenerated: async updated => { regenerated.push(updated) },
  })
  document.body.replaceChildren(api.element)
  return api
}

const q = <T extends Element>(sel: string): T => document.querySelector(sel) as T
const qa = (sel: string): Element[] => [...document.querySelectorAll(sel)]

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
  document.body.replaceChildren()
  statuses = []
  regenerated = []
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue([])
})

describe('the job list', () => {
  it('says nothing has been recorded yet', async () => {
    view()
    await flush()
    expect(q('.memory-summary-job')).toBeNull()
    expect(document.body.textContent).not.toBe('')
  })

  it('lists only the jobs the user can act on', async () => {
    mocks.invoke.mockResolvedValue([
      job({ id: 'a', status: 'pending' }),
      job({ id: 'b', status: 'failed' }),
      job({ id: 'c', status: 'completed' }),
      job({ id: 'd', status: 'skipped' }),
    ])
    view()
    await flush()
    expect(qa('.memory-summary-job')).toHaveLength(2)
  })

  it('says there is nothing to act on when every job finished', async () => {
    mocks.invoke.mockResolvedValue([job({ status: 'completed' })])
    view()
    await flush()
    expect(qa('.memory-summary-job')).toHaveLength(0)
    expect(document.body.textContent).not.toBe('')
  })

  it('describes a job by agent, project and status, with its error', async () => {
    mocks.invoke.mockResolvedValue([job({ status: 'failed', error: 'model timed out' })])
    view()
    await flush()
    const text = q('.memory-summary-job div').textContent ?? ''
    expect(text).toContain('claude')
    expect(text).toContain('bento')
    expect(text).toContain('failed')
    expect(text).toContain('model timed out')
  })

  it('opens itself when something failed', async () => {
    mocks.invoke.mockResolvedValue([job({ status: 'failed' })])
    const api = view()
    await flush()
    expect((api.element as HTMLDetailsElement).open).toBe(true)
  })

  it('stays closed when only pending work is listed', async () => {
    mocks.invoke.mockResolvedValue([job({ status: 'pending' })])
    const api = view()
    await flush()
    expect((api.element as HTMLDetailsElement).open).toBe(false)
  })

  it('shows nothing rather than failing when the backend is unreachable', async () => {
    mocks.invoke.mockRejectedValue(new Error('no backend'))
    view()
    await flush()
    expect(qa('.memory-summary-job')).toHaveLength(0)
  })
})

describe('retrying a job', () => {
  // The list command must keep answering: retrying reloads the list afterwards.
  const setup = async (status: MemorySummaryJob['status'] = 'failed') => {
    mocks.invoke.mockResolvedValue([job({ status, sessionId: 'sess-9' })])
    view()
    await flush()
    mocks.invoke.mockClear()
  }

  const answerRegenerate = (result: MemoryEntry | null | Error): void => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== 'memory_regenerate_summary') return []
      if (result instanceof Error) throw result
      return result
    })
  }

  it('asks the backend to regenerate that session summary', async () => {
    await setup()
    answerRegenerate(null)
    q<HTMLButtonElement>('.memory-summary-job button').click()
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('memory_regenerate_summary', {
      projectPath: '/home/ana/bento',
      externalId: 'claude:session-summary:sess-9',
    })
  })

  it('hands the regenerated entry back to the panel', async () => {
    await setup()
    const updated = { id: 'm1' } as MemoryEntry
    answerRegenerate(updated)
    q<HTMLButtonElement>('.memory-summary-job button').click()
    await flush()
    expect(regenerated).toEqual([updated])
  })

  it('reports when the summarizer had nothing to give back', async () => {
    await setup()
    answerRegenerate(null)
    q<HTMLButtonElement>('.memory-summary-job button').click()
    await flush()
    expect(regenerated).toEqual([null])
    expect(statuses.at(-1)?.entry).toBeUndefined()
  })

  it('reports a failure and reloads the list', async () => {
    await setup()
    answerRegenerate(new Error('agent unavailable'))
    q<HTMLButtonElement>('.memory-summary-job button').click()
    await flush()
    expect(statuses.map(s => s.message).join()).toContain('agent unavailable')
  })

  it('offers a retry for a pending job too', async () => {
    await setup('pending')
    expect(q('.memory-summary-job button')).not.toBeNull()
  })
})
