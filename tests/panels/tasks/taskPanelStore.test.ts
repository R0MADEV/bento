// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskPanelStore } from '../../../src/panels/tasks/TaskPanelStore'

describe('TaskPanelStore', () => {
  const values = new Map<string, string>()
  beforeEach(() => {
    values.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps repositories and selections isolated per panel', () => {
    const first = new TaskPanelStore('one')
    const second = new TaskPanelStore('two')
    first.setRepository('/first')
    second.setRepository('/second')
    first.setSelected('/first/task')
    expect(first.repository()).toBe('/first')
    expect(second.repository()).toBe('/second')
    expect(first.selected()).toBe('/first/task')
    expect(second.selected()).toBeNull()
  })

  it('does not resurrect the legacy repo after removing the last repository', () => {
    const store = new TaskPanelStore('one')
    store.setRepository('/legacy')   // legacy single-repo key (pre multi-repo)
    store.addRepository('/legacy')   // migrate it into the repos list
    expect(store.repositories()).toEqual(['/legacy'])
    store.removeRepository('/legacy')
    expect(store.repositories()).toEqual([])
  })

  it('redacts credentials and clears one branch operation history', () => {
    const store = new TaskPanelStore('one')
    store.recordOperation('/repo', 'feat/a', 'push', 'error', 'token=secret-value')
    store.recordOperation('/repo', 'feat/b', 'push', 'success', 'ok')
    expect(store.operations()[0].detail).not.toContain('secret-value')
    store.clearOperations('/repo', 'feat/a')
    expect(store.operations().map(entry => entry.branch)).toEqual(['feat/b'])
  })

  it('persists recipe identity per panel and resets it when repository changes', () => {
    const store = new TaskPanelStore('one')
    store.setRepository('/repo-a')
    store.setProjectKey('company--repo-a')
    store.setDevcontainerDir('apps/api/.devcontainer')
    expect(store.projectKey()).toBe('company--repo-a')
    expect(store.devcontainerDir()).toBe('apps/api/.devcontainer')

    store.setRepository('/repo-b')
    expect(store.projectKey()).toBeNull()
    expect(store.devcontainerDir()).toBeNull()
  })
})
