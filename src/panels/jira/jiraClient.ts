import { invoke } from '@tauri-apps/api/core'
import { basicAuth } from '../../core/jira/auth'
import { apiUrl } from '../../core/jira/urls'
import { parseIssues, type JiraIssue } from '../../core/jira/issues'
import { parseAgileBoards, parseAgileColumns, type AgileBoard, type AgileColumn } from '../../core/jira/board'
import { parseIssueDetail, parsePullRequests, type IssueDetail } from '../../core/jira/issueDetail'

export interface JiraAccount { id: string; site: string; email: string; token: string }

interface HttpResponse { status: number; body: string }

const ISSUE_LIST_FIELDS = 'summary,status,issuetype,assignee'
const DETAIL_FIELDS = 'description,attachment,assignee,reporter,priority,customfield_10020,fixVersions,timeoriginalestimate'

export interface JiraClient {
  /** One authenticated REST call against the active account. */
  request: (method: string, path: string, body?: unknown) => Promise<unknown>
  searchIssues: (jql: string) => Promise<JiraIssue[]>
  fetchIssueDetail: (key: string) => Promise<IssueDetail>
  createIssue: (project: string, type: string, summary: string, description: string, accountId?: string) => Promise<unknown>
  resolveAccountId: (email: string) => Promise<string | null>
  fetchAgileBoards: (nameFilter?: string) => Promise<AgileBoard[]>
  fetchBoardColumns: (boardId: number) => Promise<AgileColumn[]>
  fetchBoardIssues: (boardId: number) => Promise<JiraIssue[]>
  /** A binary asset (image) fetched with Jira auth, as a base64 data URL. */
  fetchAsDataUrl: (url: string) => Promise<string>
}

/** The Jira REST surface the panel uses, bound to whichever account is active. */
export function createJiraClient(getAccount: () => JiraAccount | null): JiraClient {
  const requireAccount = (): JiraAccount => {
    const account = getAccount()
    if (!account) throw new Error('No account selected')
    return account
  }

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const account = requireAccount()
    const res = await invoke<HttpResponse>('http_request', {
      method,
      url: apiUrl(account.site, path),
      headers: [
        ['Authorization', basicAuth(account.email, account.token)],
        ['Accept', 'application/json'],
        ['Content-Type', 'application/json'],
      ],
      body: body !== undefined ? JSON.stringify(body) : null,
    })
    if (res.status >= 400) throw new Error(`HTTP ${res.status} — ${res.body.slice(0, 300)}`)
    return res.body ? JSON.parse(res.body) : null
  }

  const searchIssues = async (jql: string): Promise<JiraIssue[]> =>
    parseIssues(await request('POST', 'api/3/search/jql', {
      jql,
      fields: ISSUE_LIST_FIELDS.split(','),
      maxResults: 50,
    }))

  const fetchIssueDetail = async (key: string): Promise<IssueDetail> => {
    const json = await request('GET', `api/2/issue/${key}?fields=${DETAIL_FIELDS}&expand=renderedFields`)
    const detail = parseIssueDetail(json)
    // Only instances with the development panel answer this one.
    const dev = await request('GET', `dev-info/0.10/issue/detail/${key}?_format=summary`).catch(() => null)
    return { ...detail, pullRequests: parsePullRequests(dev) }
  }

  const createIssue = (
    project: string, type: string, summary: string, description: string, accountId?: string,
  ): Promise<unknown> => {
    const fields: Record<string, unknown> = { project: { key: project }, issuetype: { name: type }, summary, description }
    if (accountId) fields.assignee = { accountId }
    return request('POST', 'api/2/issue', { fields })
  }

  const resolveAccountId = async (email: string): Promise<string | null> => {
    if (!email) return null
    const users = await request('GET', `api/2/user/search?query=${encodeURIComponent(email)}`) as Array<{ accountId?: string }>
    return Array.isArray(users) && users[0]?.accountId ? users[0].accountId : null
  }

  const fetchAgileBoards = async (nameFilter = ''): Promise<AgileBoard[]> => {
    const q = nameFilter ? `&name=${encodeURIComponent(nameFilter)}` : ''
    return parseAgileBoards(await request('GET', `agile/1.0/board?maxResults=100${q}`))
  }

  const fetchBoardColumns = async (boardId: number): Promise<AgileColumn[]> =>
    parseAgileColumns(await request('GET', `agile/1.0/board/${boardId}/configuration`))

  // Scrum boards show the active sprint; kanban boards have none, so fall back
  // to the whole board.
  const fetchBoardIssues = async (boardId: number): Promise<JiraIssue[]> => {
    try {
      const sprintRes = await request('GET', `agile/1.0/board/${boardId}/sprint?state=active&maxResults=1`) as { values?: Array<{ id: number }> }
      const sprintId = sprintRes?.values?.[0]?.id
      if (sprintId) {
        return parseIssues(await request('GET', `agile/1.0/sprint/${sprintId}/issue?fields=${ISSUE_LIST_FIELDS}&maxResults=100`))
      }
    } catch { /* not a scrum board, or no active sprint */ }
    return parseIssues(await request('GET', `agile/1.0/board/${boardId}/issue?fields=${ISSUE_LIST_FIELDS}&maxResults=100`))
  }

  const fetchAsDataUrl = async (url: string): Promise<string> => {
    const account = requireAccount()
    return invoke<string>('http_fetch_base64', {
      url,
      headers: [['Authorization', basicAuth(account.email, account.token)]],
    })
  }

  return {
    request, searchIssues, fetchIssueDetail, createIssue, resolveAccountId,
    fetchAgileBoards, fetchBoardColumns, fetchBoardIssues, fetchAsDataUrl,
  }
}
