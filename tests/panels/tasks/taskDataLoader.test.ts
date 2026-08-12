// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, taskGitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  taskGitMock: {
    remoteBranches: vi.fn(),
    worktrees: vi.fn(),
    safeStatus: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../../../src/panels/tasks/taskGitClient', () => ({ taskGit: taskGitMock }))
vi.mock('../../../src/panels/tasks/taskJiraClient', () => ({
  loadJiraConfig: vi.fn(async () => null),
  fetchIssue: vi.fn(async () => null),
}))

import { loadTaskData } from '../../../src/panels/tasks/TaskDataLoader'

describe('loadTaskData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    taskGitMock.remoteBranches.mockResolvedValue([])
    taskGitMock.worktrees.mockResolvedValue([
      { path: 'C:/repo', branch: 'main', head: 'abc', bare: false },
      { path: 'C:/tarea unicode ñ', branch: 'task/e2e', head: 'def', bare: false },
    ])
    taskGitMock.safeStatus.mockResolvedValue({ raw: '', staged: 0, unstaged: 0, untracked: 0, total: 0 })
  })

  it('renders discovered worktrees before optional integrations finish', async () => {
    const dockerNeverCompletes = new Promise<string>(() => {})
    invokeMock.mockImplementation((command: string) => {
      if (command === 'git_default_branch') return Promise.resolve('main')
      if (command === 'git_fetch_info') return Promise.resolve({ fetchedAt: 0 })
      if (command === 'docker_list') return dockerNeverCompletes
      return Promise.resolve(null)
    })
    const renderList = vi.fn()

    void loadTaskData({
      repoPath: 'C:\\repo',
      panelStore: {
        savedBase: () => null,
        setBase: () => {},
        selected: () => null,
        setSelected: () => {},
      },
      baseSelect: document.createElement('select'),
      filterInput: document.createElement('input'),
      listWrap: document.createElement('div'),
      fetchAgeEl: document.createElement('span'),
      note: text => Object.assign(document.createElement('div'), { textContent: text }),
      setBaseBranch: () => {},
      setWorktrees: () => {},
      setJiraConfig: () => {},
      maps: {
        issue: new Map(),
        aheadBehind: new Map(),
        pr: new Map(),
        backup: new Map(),
        rebase: new Map(),
        upstream: new Map(),
      },
      renderList,
      shouldRestoreSelection: () => true,
      selectRow: () => {},
      showChanges: () => {},
      showRebasePaused: () => {},
    })

    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(renderList).toHaveBeenCalledTimes(1)
    expect([...renderList.mock.calls[0][0].keys()]).toEqual(['C:/repo', 'C:/tarea unicode ñ'])
  })

  it('does not restore a selection made during progressive enrichment', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'git_default_branch') return Promise.resolve('main')
      if (command === 'git_fetch_info') return Promise.resolve({ fetchedAt: 0 })
      if (command === 'docker_list' || command === 'git_ahead_behind') return Promise.resolve('')
      if (command === 'git_backup_status') return Promise.resolve({ available: false, different: null, hash: null, short: null, subject: null })
      if (command === 'git_rebase_status') return Promise.resolve({ active: false })
      return Promise.resolve(null)
    })
    let selectedPath: string | null = 'C:/tarea unicode ñ'
    let interacted = false
    const listWrap = document.createElement('div')
    const showChanges = vi.fn()
    const renderList = vi.fn(() => {
      interacted = true
      const rows = ['C:/repo', 'C:/tarea unicode ñ'].map(path => {
        const row = document.createElement('div')
        row.className = 'tasks-row'
        row.dataset.path = path
        return row
      })
      listWrap.replaceChildren(...rows)
    })

    await loadTaskData({
      repoPath: 'C:\\repo',
      panelStore: {
        savedBase: () => null,
        setBase: () => {},
        selected: () => selectedPath,
        setSelected: path => { selectedPath = path },
      },
      baseSelect: document.createElement('select'),
      filterInput: document.createElement('input'),
      listWrap,
      fetchAgeEl: document.createElement('span'),
      note: text => Object.assign(document.createElement('div'), { textContent: text }),
      setBaseBranch: () => {},
      setWorktrees: () => {},
      setJiraConfig: () => {},
      maps: {
        issue: new Map(), aheadBehind: new Map(), pr: new Map(),
        backup: new Map(), rebase: new Map(), upstream: new Map(),
      },
      renderList,
      shouldRestoreSelection: () => !interacted,
      selectRow: () => {},
      showChanges,
      showRebasePaused: () => {},
    })

    expect(renderList).toHaveBeenCalledTimes(2)
    expect(showChanges).not.toHaveBeenCalled()
  })
})
