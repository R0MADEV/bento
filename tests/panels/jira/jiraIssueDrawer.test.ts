// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: mocks.openUrl }))

import { showIssueDetail } from '../../../src/panels/jira/jiraIssueDrawer'
// El panel pinta en el idioma activo: buscar un botón por su texto en español
// solo funcionaba mientras el panel estaba sin traducir.
import { t as i18nT } from '../../../src/i18n'
import type { JiraIssue } from '../../../src/core/jira/issues'
import type { IssueDetail } from '../../../src/core/jira/issueDetail'
import type { JiraAccount, JiraClient } from '../../../src/panels/jira/jiraClient'

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

const account: JiraAccount = { id: 'a1', site: 'acme.atlassian.net', email: 'ana@acme.com', token: 'tok' }

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: 'K-1', summary: 'A summary', status: 'To Do', statusCategory: 'new', type: 'Task',
  assignee: '', assigneeId: '', assigneeAvatar: '', ...over,
} as JiraIssue)

const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  description: 'a description', isRenderedHtml: false, attachments: [], pullRequests: [],
  assignee: '', assigneeAvatar: '', reporter: '', reporterAvatar: '',
  priority: '', sprint: '', fixVersions: [], estimate: '', ...over,
})

function jiraClient(over: Partial<JiraClient> = {}): JiraClient {
  return {
    request: vi.fn(async () => ({})),
    searchIssues: vi.fn(async () => []),
    fetchIssueDetail: vi.fn(async () => detail()),
    createIssue: vi.fn(async () => ({})),
    resolveAccountId: vi.fn(async () => null),
    fetchAgileBoards: vi.fn(async () => []),
    fetchBoardColumns: vi.fn(async () => []),
    fetchBoardIssues: vi.fn(async () => []),
    fetchAsDataUrl: vi.fn(async () => 'data:image/png;base64,AAA'),
    ...over,
  }
}

function setup(over: { jira?: Partial<JiraClient>; issue?: JiraIssue } = {}) {
  const detailPane = document.createElement('div')
  document.body.replaceChildren(detailPane)
  const jira = jiraClient(over.jira)
  const state = {
    viewMode: 'board' as 'board' | 'list',
    selectedBoardId: null as number | null,
    agileColumns: [] as ReturnType<JiraClient['fetchBoardColumns']> extends Promise<infer T> ? T : never,
    cachedIssues: [] as JiraIssue[],
    assigneeResets: 0,
  }
  const promise = showIssueDetail({
    jira,
    getActiveAccount: () => account,
    detailPane,
    getViewMode: () => state.viewMode,
    getSelectedBoardId: () => state.selectedBoardId,
    getAgileColumns: () => state.agileColumns,
    setAgileColumns: cols => { state.agileColumns = cols },
    getCachedIssues: () => state.cachedIssues,
    setCachedIssues: issues => { state.cachedIssues = issues },
    resetAssigneeFilter: () => { state.assigneeResets++ },
  }, over.issue ?? issue())
  return { detailPane, jira, state, promise }
}

const q = <T extends Element>(sel: string): T => document.querySelector(sel) as T
const qa = (sel: string): Element[] => [...document.querySelectorAll(sel)]

beforeEach(() => {
  document.body.replaceChildren()
  mocks.openUrl.mockReset()
  mocks.openUrl.mockResolvedValue(undefined)
})

describe('the drawer shell', () => {
  it('shows the key, status and type before the detail loads', async () => {
    setup({ issue: issue({ key: 'K-9', status: 'Doing', type: 'Bug' }) })
    expect(q('.jira-key').textContent).toBe('K-9')
    expect(q('.jira-status').textContent).toBe('Doing')
    expect(q('.jira-type').textContent).toBe('Bug')
  })

  it('closes on a click outside the drawer, not inside it', async () => {
    const { detailPane, promise } = setup()
    await promise
    await flush()
    q<HTMLElement>('.jira-drawer-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(detailPane.querySelector('.jira-drawer-overlay')).toBeNull()
  })

  it('opens the issue in the browser', async () => {
    const { promise } = setup({ issue: issue({ key: 'K-1' }) })
    await promise
    await flush()
    ;(qa('.jira-header button')[0] as HTMLButtonElement).click()
    expect(mocks.openUrl).toHaveBeenCalledWith(expect.stringContaining('K-1'))
  })
})

describe('the description', () => {
  it('renders Jira-provided HTML as-is', async () => {
    const { promise } = setup({ jira: { fetchIssueDetail: async () => detail({ isRenderedHtml: true, description: '<p>hi</p>' }) } })
    await promise
    await flush()
    expect(q('.jira-detail-desc').innerHTML).toBe('<p>hi</p>')
  })

  it('parses wiki markup when there is no rendered HTML', async () => {
    const { promise } = setup({ jira: { fetchIssueDetail: async () => detail({ description: 'h1. Title' }) } })
    await promise
    await flush()
    expect(q('.jira-detail-desc h1')).not.toBeNull()
  })

  it('shows a placeholder for an empty description', async () => {
    const { promise } = setup({ jira: { fetchIssueDetail: async () => detail({ description: '' }) } })
    await promise
    await flush()
    expect(q('.jira-detail-desc em')).not.toBeNull()
  })

  it('reports an error instead of hanging when the detail fetch fails', async () => {
    const { promise } = setup({ jira: { fetchIssueDetail: async () => { throw new Error('down') } } })
    await promise
    await flush()
    expect(q('.jira-detail-desc').textContent).toBe(i18nT('jira.errorLoadingDescription'))
  })
})

describe('metadata', () => {
  it('lists only the fields that have a value', async () => {
    const { promise } = setup({ jira: { fetchIssueDetail: async () => detail({ assignee: 'Ana', priority: '', sprint: '' }) } })
    await promise
    await flush()
    const labels = qa('.jira-meta-label').map(e => e.textContent)
    expect(labels.some(l => l?.includes('ASIGN'))).toBe(true)
    expect(labels.some(l => l?.includes('PRIOR'))).toBe(false)
  })

  it('shows the fix versions joined when there are any', async () => {
    const { promise } = setup({ jira: { fetchIssueDetail: async () => detail({ fixVersions: ['1.0', '1.1'] }) } })
    await promise
    await flush()
    const row = qa('.jira-meta-row').find(r => r.textContent?.includes('1.0'))
    expect(row?.textContent).toContain('1.1')
  })
})

describe('attachments', () => {
  it('shows a thumbnail for image attachments', async () => {
    const { promise } = setup({
      jira: { fetchIssueDetail: async () => detail({ attachments: [{ id: '1', filename: 'a.png', content: '/a.png', thumbnail: '', mimeType: 'image/png' }] }) },
    })
    await promise
    await flush()
    expect(q('.jira-att-thumb')).not.toBeNull()
  })

  it('shows a plain icon for a non-image attachment', async () => {
    const { promise } = setup({
      jira: { fetchIssueDetail: async () => detail({ attachments: [{ id: '1', filename: 'a.pdf', content: '/a.pdf', thumbnail: '', mimeType: 'application/pdf' }] }) },
    })
    await promise
    await flush()
    expect(q('.jira-att-icon')).not.toBeNull()
    expect(q('.jira-att-thumb')).toBeNull()
  })
})

describe('transitions', () => {
  it('offers every transition except the one back to the current status', async () => {
    const { promise } = setup({
      jira: {
        request: vi.fn(async (method: string, path: string) => {
          if (path.endsWith('/transitions')) {
            return { transitions: [{ id: '1', name: 'x', to: { name: 'To Do' } }, { id: '2', name: 'x', to: { name: 'Done' } }] }
          }
          return {}
        }),
      },
      issue: issue({ status: 'To Do' }),
    })
    await promise
    await flush()
    const labels = qa('.jira-transition-btn').map(b => b.textContent)
    expect(labels).toEqual(['Done'])
  })

  it('applies the clicked transition and closes the drawer', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (path.endsWith('/transitions') && method === 'GET') return { transitions: [{ id: '2', name: 'x', to: { name: 'Done' } }] }
      return {}
    })
    const { detailPane, promise } = setup({ jira: { request } })
    await promise
    await flush()
    q<HTMLButtonElement>('.jira-transition-btn').click()
    await flush()
    expect(request).toHaveBeenCalledWith('POST', expect.stringContaining('/transitions'), { transition: { id: '2' } })
    expect(detailPane.querySelector('.jira-drawer-overlay')).toBeNull()
  })

  it('refreshes the board issues after a transition when viewing the board', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/transitions')) return { transitions: [{ id: '2', name: 'x', to: { name: 'Done' } }] }
      return {}
    })
    const fetchBoardIssues = vi.fn(async () => [issue({ key: 'K-2' })])
    const { state, promise } = setup({ jira: { request, fetchBoardIssues } })
    state.viewMode = 'board'
    state.selectedBoardId = 7
    await promise
    await flush()
    q<HTMLButtonElement>('.jira-transition-btn').click()
    await flush()
    expect(fetchBoardIssues).toHaveBeenCalledWith(7)
    expect(state.cachedIssues.map(i => i.key)).toEqual(['K-2'])
    expect(state.assigneeResets).toBe(1)
  })

  it('re-enables the button when the transition fails', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (path.endsWith('/transitions') && method === 'GET') return { transitions: [{ id: '2', name: 'x', to: { name: 'Done' } }] }
      if (method === 'POST') throw new Error('locked')
      return {}
    })
    const { promise } = setup({ jira: { request } })
    await promise
    await flush()
    const btn = q<HTMLButtonElement>('.jira-transition-btn')
    btn.click()
    await flush()
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('Done')
  })
})

describe('pull requests', () => {
  it('lists each pull request by title', async () => {
    const { promise } = setup({
      jira: { fetchIssueDetail: async () => detail({ pullRequests: [{ title: 'Fix bug', url: '/pr/1', status: 'OPEN' }] }) },
    })
    await promise
    await flush()
    expect(q('.jira-pr-row').textContent).toBe('Fix bug')
  })

  it('opens the pull request in the browser', async () => {
    const { promise } = setup({
      jira: { fetchIssueDetail: async () => detail({ pullRequests: [{ title: 'Fix bug', url: '/pr/1', status: 'OPEN' }] }) },
    })
    await promise
    await flush()
    q<HTMLElement>('.jira-pr-row').click()
    expect(mocks.openUrl).toHaveBeenCalledWith('/pr/1')
  })
})

describe('editing the estimate', () => {
  it('opens an editor on click and saves through the API', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (path.endsWith('/transitions')) return {}
      return {}
    })
    const { promise } = setup({ jira: { request, fetchIssueDetail: async () => detail({ estimate: '2h' }) } })
    await promise
    await flush()
    q<HTMLElement>('.jira-meta-row[data-field="estimate"] .jira-meta-value').click()
    const input = q<HTMLInputElement>('.jira-meta-row[data-field="estimate"] input')
    input.value = '3h'
    q<HTMLButtonElement>('.jira-meta-row[data-field="estimate"] .jira-primary').click()
    await flush()
    expect(request).toHaveBeenCalledWith('PUT', expect.stringContaining('K-1'), {
      update: { timetracking: [{ set: { originalEstimate: '3h' } }] },
    })
  })
})

describe('editing the description', () => {
  it('saves the new text as wiki markup and re-renders it', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (path.endsWith('/transitions')) return {}
      return {}
    })
    const { promise } = setup({ jira: { request, fetchIssueDetail: async () => detail({ description: 'old' }) } })
    await promise
    await flush()
    q<HTMLButtonElement>('.jira-header button:last-child').click()
    const ta = q<HTMLTextAreaElement>('.jira-detail-desc textarea')
    ta.value = 'h1. New'
    ;[...document.querySelectorAll('.jira-primary')].find(b => b.textContent === i18nT('common.save'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(request).toHaveBeenCalledWith('PUT', expect.stringContaining('K-1'), { fields: { description: 'h1. New' } })
    expect(q('.jira-detail-desc h1')).not.toBeNull()
  })
})

describe('comments', () => {
  it('loads and renders existing comments', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (path.includes('/comment')) return { comments: [{ body: 'Hi', author: { displayName: 'Ana' } }] }
      return {}
    })
    const { promise } = setup({ jira: { request } })
    await promise
    await flush()
    expect(q('.jira-comment-body').textContent).toBe('Hi')
    expect(q('.jira-comment-meta').textContent).toContain('Ana')
  })

  it('says so when there are none', async () => {
    const request = vi.fn(async (method: string, path: string) => (path.includes('/comment') ? { comments: [] } : {}))
    const { promise } = setup({ jira: { request } })
    await promise
    await flush()
    expect(q('.jira-comment-list').textContent).not.toBe('')
  })

  it('posts a new comment and reloads the list', async () => {
    let posted = false
    const request = vi.fn(async (method: string, path: string) => {
      if (path.includes('/comment') && method === 'POST') { posted = true; return {} }
      if (path.includes('/comment')) return { comments: posted ? [{ body: 'New one' }] : [] }
      return {}
    })
    const { promise } = setup({ jira: { request } })
    await promise
    await flush()
    const commentInput = [...document.querySelectorAll('textarea')].find(t => t.placeholder === i18nT('jira.writeAComment')) as HTMLTextAreaElement
    commentInput.value = 'New one'
    const submit = [...document.querySelectorAll('button')].find(b => b.textContent === i18nT('jira.comment')) as HTMLButtonElement
    submit.click()
    await flush()
    expect(request).toHaveBeenCalledWith('POST', expect.stringContaining('/comment'), { body: 'New one' })
    expect(commentInput.value).toBe('')
  })
})
