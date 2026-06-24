export interface JiraIssue {
  key: string
  summary: string
  status: string
  statusCategory: string
  type: string
  assignee: string
}

// Flatten Jira's /search response (issues[].fields.*) into a simple list.
export function parseIssues(json: unknown): JiraIssue[] {
  const issues = (json as { issues?: unknown })?.issues
  if (!Array.isArray(issues)) return []
  return issues.map(i => {
    const f = i?.fields ?? {}
    return {
      key: i?.key ?? '',
      summary: f.summary ?? '',
      status: f.status?.name ?? '',
      statusCategory: f.status?.statusCategory?.key ?? '',
      type: f.issuetype?.name ?? '',
      assignee: f.assignee?.displayName ?? '',
    }
  })
}
