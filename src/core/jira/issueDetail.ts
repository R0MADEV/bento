export interface JiraAttachment {
  id: string
  filename: string
  content: string
  thumbnail: string
  mimeType: string
}

export interface JiraPullRequest {
  title: string
  url: string
  status: string
}

export interface IssueDetail {
  description: string
  /** True when Jira gave us its own HTML instead of raw wiki markup. */
  isRenderedHtml: boolean
  attachments: JiraAttachment[]
  pullRequests: JiraPullRequest[]
  assignee: string
  assigneeAvatar: string
  reporter: string
  reporterAvatar: string
  priority: string
  sprint: string
  fixVersions: string[]
  estimate: string
}

interface RawUser { displayName?: string; avatarUrls?: { '48x48'?: string } }

interface RawIssueDetail {
  renderedFields?: { description?: string }
  fields?: {
    description?: string
    attachment?: Array<Partial<JiraAttachment>>
    assignee?: RawUser
    reporter?: RawUser
    priority?: { name?: string }
    // Sprints live in a per-instance custom field; 10020 is the common default.
    customfield_10020?: Array<{ name?: string }>
    fixVersions?: Array<{ name?: string }>
    timeoriginalestimate?: number
  }
}

const SECONDS_PER_HOUR = 3600

/** An issue's detail fields, with every absent value defaulted rather than undefined. */
export function parseIssueDetail(json: unknown): IssueDetail {
  const issue = (json ?? {}) as RawIssueDetail
  const f = issue.fields ?? {}
  const renderedDescription = issue.renderedFields?.description
  const seconds = f.timeoriginalestimate

  return {
    description: renderedDescription ?? f.description ?? '',
    isRenderedHtml: Boolean(renderedDescription),
    attachments: (f.attachment ?? []).map(a => ({
      id: a.id ?? '',
      filename: a.filename ?? '',
      content: a.content ?? '',
      thumbnail: a.thumbnail ?? '',
      mimeType: a.mimeType ?? '',
    })),
    pullRequests: [],
    assignee: f.assignee?.displayName ?? '',
    assigneeAvatar: f.assignee?.avatarUrls?.['48x48'] ?? '',
    reporter: f.reporter?.displayName ?? '',
    reporterAvatar: f.reporter?.avatarUrls?.['48x48'] ?? '',
    priority: f.priority?.name ?? '',
    sprint: (f.customfield_10020 ?? []).map(s => s.name).filter(Boolean).join(', '),
    fixVersions: (f.fixVersions ?? []).map(v => v.name ?? '').filter(Boolean),
    estimate: seconds ? `${Math.round(seconds / SECONDS_PER_HOUR)}h` : '',
  }
}

/** The linked pull requests, which only instances with the dev-info panel report. */
export function parsePullRequests(json: unknown): JiraPullRequest[] {
  const dev = (json ?? {}) as { detail?: Array<{ pullRequests?: Array<Partial<JiraPullRequest>> }> }
  return (dev.detail ?? []).flatMap(d => d.pullRequests ?? []).map(pr => ({
    title: pr.title ?? '',
    url: pr.url ?? '',
    status: pr.status ?? '',
  }))
}
