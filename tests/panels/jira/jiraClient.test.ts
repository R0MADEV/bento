import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { createJiraClient, type JiraAccount } from '../../../src/panels/jira/jiraClient'

const account: JiraAccount = { id: 'a1', site: 'acme.atlassian.net', email: 'ana@acme.com', token: 'tok' }

const ok = (body: unknown): { status: number; body: string } =>
  ({ status: 200, body: typeof body === 'string' ? body : JSON.stringify(body) })

function client(over: { account?: JiraAccount | null } = {}) {
  return createJiraClient(() => ('account' in over ? over.account ?? null : account))
}

const lastCall = (): { method: string; url: string; headers: string[][]; body: string | null } =>
  mocks.invoke.mock.calls.at(-1)![1] as never

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue(ok(null))
})

describe('the request itself', () => {
  it('refuses to call anything without an account', async () => {
    await expect(client({ account: null }).request('GET', 'api/2/myself')).rejects.toThrow()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('builds the URL from the account site', async () => {
    await client().request('GET', 'api/2/myself')
    expect(lastCall().url).toContain('acme.atlassian.net')
    expect(lastCall().url).toContain('api/2/myself')
  })

  it('sends basic auth and JSON headers', async () => {
    await client().request('GET', 'api/2/myself')
    const headers = Object.fromEntries(lastCall().headers)
    expect(headers.Authorization).toMatch(/^Basic /)
    expect(headers.Accept).toBe('application/json')
  })

  it('sends no body for a GET and a JSON body when given one', async () => {
    await client().request('GET', 'x')
    expect(lastCall().body).toBeNull()
    await client().request('POST', 'x', { a: 1 })
    expect(lastCall().body).toBe('{"a":1}')
  })

  it('parses the JSON response, and gives null for an empty one', async () => {
    mocks.invoke.mockResolvedValue(ok({ ok: true }))
    expect(await client().request('GET', 'x')).toEqual({ ok: true })
    mocks.invoke.mockResolvedValue({ status: 204, body: '' })
    expect(await client().request('GET', 'x')).toBeNull()
  })

  it('turns an error status into a throw carrying the status and body', async () => {
    mocks.invoke.mockResolvedValue({ status: 403, body: 'no permission' })
    await expect(client().request('GET', 'x')).rejects.toThrow(/403/)
    await expect(client().request('GET', 'x')).rejects.toThrow(/no permission/)
  })
})

describe('searchIssues', () => {
  it('posts the JQL and parses the issues out', async () => {
    mocks.invoke.mockResolvedValue(ok({
      issues: [{ key: 'K-1', fields: { summary: 'One', status: { name: 'To Do', statusCategory: { key: 'new' } } } }],
    }))
    const issues = await client().searchIssues('assignee = currentUser()')
    expect(JSON.parse(lastCall().body!).jql).toBe('assignee = currentUser()')
    expect(issues.map(i => i.key)).toEqual(['K-1'])
  })
})

describe('fetchIssueDetail', () => {
  it('asks for the rendered fields and merges in the pull requests', async () => {
    mocks.invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const url = (args as { url: string }).url
      if (url.includes('dev-info')) return ok({ detail: [{ pullRequests: [{ title: 'PR', url: '/p', status: 'OPEN' }] }] })
      return ok({ fields: { priority: { name: 'High' } }, renderedFields: { description: '<p>hi</p>' } })
    })
    const detail = await client().fetchIssueDetail('K-1')
    expect(detail.priority).toBe('High')
    expect(detail.isRenderedHtml).toBe(true)
    expect(detail.pullRequests).toEqual([{ title: 'PR', url: '/p', status: 'OPEN' }])
  })

  it('still returns the issue when the instance has no dev-info panel', async () => {
    mocks.invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      if ((args as { url: string }).url.includes('dev-info')) throw new Error('404')
      return ok({ fields: { priority: { name: 'Low' } } })
    })
    const detail = await client().fetchIssueDetail('K-1')
    expect(detail.priority).toBe('Low')
    expect(detail.pullRequests).toEqual([])
  })
})

describe('createIssue', () => {
  it('sends the project, type, summary and description', async () => {
    await client().createIssue('KAN', 'Task', 'A summary', 'Some details')
    expect(JSON.parse(lastCall().body!).fields).toMatchObject({
      project: { key: 'KAN' }, issuetype: { name: 'Task' }, summary: 'A summary', description: 'Some details',
    })
  })

  it('only sets an assignee when one was given', async () => {
    await client().createIssue('KAN', 'Task', 'S', 'D')
    expect(JSON.parse(lastCall().body!).fields.assignee).toBeUndefined()
    await client().createIssue('KAN', 'Task', 'S', 'D', 'acc-1')
    expect(JSON.parse(lastCall().body!).fields.assignee).toEqual({ accountId: 'acc-1' })
  })
})

describe('resolveAccountId', () => {
  it('looks the user up by email and returns the first match', async () => {
    mocks.invoke.mockResolvedValue(ok([{ accountId: 'acc-9' }]))
    expect(await client().resolveAccountId('ana@acme.com')).toBe('acc-9')
    expect(lastCall().url).toContain(encodeURIComponent('ana@acme.com'))
  })

  it('answers null without asking when there is no email', async () => {
    expect(await client().resolveAccountId('')).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('answers null when nobody matches', async () => {
    mocks.invoke.mockResolvedValue(ok([]))
    expect(await client().resolveAccountId('nobody@acme.com')).toBeNull()
  })
})

describe('agile boards', () => {
  it('lists boards, optionally filtered by name', async () => {
    mocks.invoke.mockResolvedValue(ok({ values: [{ id: 1, name: 'Board' }] }))
    await client().fetchAgileBoards()
    expect(lastCall().url).not.toContain('name=')
    await client().fetchAgileBoards('My board')
    expect(lastCall().url).toContain(`name=${encodeURIComponent('My board')}`)
  })

  it('reads a board’s columns', async () => {
    mocks.invoke.mockResolvedValue(ok({ columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '1' }] }] } }))
    const columns = await client().fetchBoardColumns(7)
    expect(lastCall().url).toContain('board/7/configuration')
    expect(columns.map(c => c.name)).toEqual(['To Do'])
  })
})

describe('board issues', () => {
  it('prefers the active sprint on a scrum board', async () => {
    mocks.invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const url = (args as { url: string }).url
      if (url.includes('/sprint?state=active')) return ok({ values: [{ id: 42 }] })
      return ok({ issues: [{ key: 'S-1', fields: { summary: 'x', status: { name: 'To Do', statusCategory: { key: 'new' } } } }] })
    })
    const issues = await client().fetchBoardIssues(7)
    expect(lastCall().url).toContain('sprint/42/issue')
    expect(issues.map(i => i.key)).toEqual(['S-1'])
  })

  it('falls back to the whole board when there is no active sprint', async () => {
    mocks.invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const url = (args as { url: string }).url
      if (url.includes('/sprint?state=active')) return ok({ values: [] })
      return ok({ issues: [] })
    })
    await client().fetchBoardIssues(7)
    expect(lastCall().url).toContain('board/7/issue')
  })

  it('falls back to the whole board when the sprint lookup fails', async () => {
    mocks.invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const url = (args as { url: string }).url
      if (url.includes('/sprint?state=active')) throw new Error('not a scrum board')
      return ok({ issues: [] })
    })
    await client().fetchBoardIssues(7)
    expect(lastCall().url).toContain('board/7/issue')
  })
})

describe('fetchAsDataUrl', () => {
  it('fetches a binary asset with the account credentials', async () => {
    mocks.invoke.mockResolvedValue('data:image/png;base64,AAA')
    expect(await client().fetchAsDataUrl('/secure/a.png')).toBe('data:image/png;base64,AAA')
    const [cmd, args] = mocks.invoke.mock.calls.at(-1) as [string, { url: string; headers: string[][] }]
    expect(cmd).toBe('http_fetch_base64')
    expect(args.url).toBe('/secure/a.png')
    expect(Object.fromEntries(args.headers).Authorization).toMatch(/^Basic /)
  })

  it('refuses without an account instead of sending empty credentials', async () => {
    await expect(client({ account: null }).fetchAsDataUrl('/a.png')).rejects.toThrow()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
