// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error?: unknown) => void } => {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Deferred<T> = ReturnType<typeof deferred<T>>

const mocks = vi.hoisted(() => ({
  deleteFailures: new Set<string>(),
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'notes_list') {
      return [
        { name: 'a.md', content: '---\ntitle: A\n---\nalpha' },
        { name: 'b.md', content: '---\ntitle: B\n---\nbeta' },
      ]
    }
    if (command === 'notes_write') {
      const name = String(args?.name ?? '')
      const pending = deferred<void>()
      const writes = mocks.writes.get(name) ?? []
      writes.push({ args, pending })
      mocks.writes.set(name, writes)
      return pending.promise
    }
    if (command === 'notes_delete') {
      const name = String(args?.name ?? '')
      if (mocks.deleteFailures.has(name)) return Promise.reject(new Error('failed to delete'))
      return undefined
    }
    return undefined
  }),
  writes: new Map<string, Array<{ args?: Record<string, unknown>; pending: Deferred<void> }>>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createNotesPanel } from '../../../src/panels/notes/NotesPanel'

describe('NotesPanel save status', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', makeLocalStorage())
    mocks.invoke.mockClear()
    mocks.writes.clear()
    mocks.deleteFailures.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps save errors scoped to the note that failed', async () => {
    const { element } = createNotesPanel()
    document.body.appendChild(element)

    await vi.waitFor(() => expect(element.querySelectorAll('.notes-item')).toHaveLength(2))

    const openNote = async (index: number, bodyText: string): Promise<void> => {
      element.querySelectorAll<HTMLButtonElement>('.notes-item')[index].click()
      const body = element.querySelector<HTMLTextAreaElement>('.notes-textarea')!
      body.value = bodyText
      body.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    }

    await openNote(0, 'alpha updated')
    await openNote(1, 'beta updated')

    mocks.writes.get('b.md')?.[0].pending.resolve(undefined)
    await Promise.resolve()
    mocks.writes.get('a.md')?.[0].pending.reject(new Error('failed to save a'))
    await Promise.resolve()

    expect(element.querySelector('.notes-save-status')?.classList.contains('hidden')).toBe(true)

    element.querySelectorAll<HTMLButtonElement>('.notes-item')[0].click()
    await vi.waitFor(() => expect(element.querySelector('.notes-save-status')?.classList.contains('hidden')).toBe(false))

    document.body.removeChild(element)
  })

  it('flushes every pending note on dispose', async () => {
    const panel = createNotesPanel()
    const { element } = panel
    document.body.appendChild(element)

    await vi.waitFor(() => expect(element.querySelectorAll('.notes-item')).toHaveLength(2))

    element.querySelectorAll<HTMLButtonElement>('.notes-item')[0].click()
    const bodyA = element.querySelector<HTMLTextAreaElement>('.notes-textarea')!
    bodyA.value = 'alpha updated'
    bodyA.dispatchEvent(new Event('input', { bubbles: true }))

    element.querySelectorAll<HTMLButtonElement>('.notes-item')[1].click()
    const bodyB = element.querySelector<HTMLTextAreaElement>('.notes-textarea')!
    bodyB.value = 'beta updated'
    bodyB.dispatchEvent(new Event('input', { bubbles: true }))

    const writesBeforeDispose = mocks.invoke.mock.calls.filter(([command]) => command === 'notes_write').length
    expect(writesBeforeDispose).toBe(0)

    panel.dispose?.()
    element.remove()

    await vi.waitFor(() => {
      const writes = mocks.invoke.mock.calls.filter(([command]) => command === 'notes_write')
      expect(writes).toHaveLength(2)
    })
  })

  it('keeps the latest content when writes resolve out of order', async () => {
    const { element } = createNotesPanel()
    document.body.appendChild(element)

    await vi.waitFor(() => expect(element.querySelectorAll('.notes-item')).toHaveLength(2))

    element.querySelectorAll<HTMLButtonElement>('.notes-item')[0].click()
    const body = element.querySelector<HTMLTextAreaElement>('.notes-textarea')!

    body.value = 'alpha first'
    body.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => {
      const writes = mocks.invoke.mock.calls.filter(([command]) => command === 'notes_write')
      expect(writes).toHaveLength(1)
      expect(String(writes[0][1]?.content)).toContain('alpha first')
    })

    body.value = 'alpha second'
    body.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_write')).toHaveLength(1)

    mocks.writes.get('a.md')?.[0].pending.resolve(undefined)
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_write')).toHaveLength(2))
    expect(String(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_write')[1][1]?.content)).toContain('alpha second')

    mocks.writes.get('a.md')?.[1].pending.resolve(undefined)
    await Promise.resolve()
    document.body.removeChild(element)
  })

  it('waits for in-flight writes before deleting a note', async () => {
    const { element } = createNotesPanel()
    document.body.appendChild(element)

    await vi.waitFor(() => expect(element.querySelectorAll('.notes-item')).toHaveLength(2))

    element.querySelectorAll<HTMLButtonElement>('.notes-item')[0].click()
    const deleteBtn = element.querySelectorAll<HTMLElement>('.notes-item-del')[0]
    const body = element.querySelector<HTMLTextAreaElement>('.notes-textarea')!
    body.value = 'alpha updated'
    body.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_delete')).toHaveLength(0)

    deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_delete')).toHaveLength(0)

    mocks.writes.get('a.md')?.[0].pending.resolve(undefined)
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_delete')).toHaveLength(1))

    document.body.removeChild(element)
  })

  it('shows an error and restores the note if deletion fails', async () => {
    mocks.deleteFailures.add('a.md')
    const { element } = createNotesPanel()
    document.body.appendChild(element)

    await vi.waitFor(() => expect(element.querySelectorAll('.notes-item')).toHaveLength(2))

    element.querySelectorAll<HTMLButtonElement>('.notes-item')[0].click()
    element.querySelectorAll<HTMLElement>('.notes-item-del')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()

    await vi.waitFor(() => expect(element.querySelector('.notes-delete-status')?.classList.contains('hidden')).toBe(false))
    expect(element.querySelector('.notes-save-status')?.classList.contains('hidden')).toBe(true)
    expect(element.querySelector('.notes-delete-status')?.classList.contains('hidden')).toBe(false)

    document.body.removeChild(element)
  })
})
