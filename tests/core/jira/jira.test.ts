import { describe, it, expect } from 'vitest'
import { basicAuth } from '../../../src/core/jira/auth'
import { parseIssues } from '../../../src/core/jira/issues'
import { normalizeSite, browseUrl, apiUrl } from '../../../src/core/jira/urls'

describe('basicAuth', () => {
  it('builds a Basic header from email:token', () => {
    // btoa('a:b') === 'YTpi'
    expect(basicAuth('a', 'b')).toBe('Basic YTpi')
  })
})

describe('normalizeSite / urls', () => {
  it('strips trailing slashes from the site', () => {
    expect(normalizeSite('https://x.atlassian.net/')).toBe('https://x.atlassian.net')
    expect(normalizeSite('https://x.atlassian.net')).toBe('https://x.atlassian.net')
  })

  it('builds browse and API urls', () => {
    expect(browseUrl('https://x.atlassian.net/', 'ABC-1')).toBe('https://x.atlassian.net/browse/ABC-1')
    expect(apiUrl('https://x.atlassian.net', 'api/3/search/jql')).toBe('https://x.atlassian.net/rest/api/3/search/jql')
    expect(apiUrl('https://x.atlassian.net/', 'api/2/issue')).toBe('https://x.atlassian.net/rest/api/2/issue')
  })
})

describe('parseIssues', () => {
  const sample = {
    issues: [
      {
        key: 'BEN-1',
        fields: {
          summary: 'Add Docker panel',
          status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          issuetype: { name: 'Task' },
          assignee: { displayName: 'Roman' },
        },
      },
    ],
  }

  it('maps the search response to flat issues', () => {
    expect(parseIssues(sample)).toEqual([
      { key: 'BEN-1', summary: 'Add Docker panel', status: 'In Progress', statusCategory: 'indeterminate', type: 'Task', assignee: 'Roman' },
    ])
  })

  it('tolerates missing fields and non-arrays', () => {
    expect(parseIssues({ issues: [{ key: 'X-1', fields: {} }] })).toEqual([
      { key: 'X-1', summary: '', status: '', statusCategory: '', type: '', assignee: '' },
    ])
    expect(parseIssues({})).toEqual([])
    expect(parseIssues(null)).toEqual([])
  })
})
