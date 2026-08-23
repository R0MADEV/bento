import { describe, expect, it } from 'vitest'
import { parseIssueDetail, parsePullRequests } from '../../../src/core/jira/issueDetail'

const raw = (fields: Record<string, unknown> = {}, rendered?: Record<string, unknown>) =>
  ({ fields, ...(rendered ? { renderedFields: rendered } : {}) })

describe('parseIssueDetail defaults', () => {
  it('gives every field a safe empty value for an issue with nothing set', () => {
    expect(parseIssueDetail(raw())).toEqual({
      description: '', isRenderedHtml: false, attachments: [], pullRequests: [],
      assignee: '', assigneeAvatar: '', reporter: '', reporterAvatar: '',
      priority: '', sprint: '', fixVersions: [], estimate: '',
    })
  })

  it('survives a response with no fields at all', () => {
    expect(parseIssueDetail(null).description).toBe('')
    expect(parseIssueDetail({}).attachments).toEqual([])
  })
})

describe('the description', () => {
  it('prefers the rendered HTML and says so', () => {
    const detail = parseIssueDetail(raw({ description: 'raw text' }, { description: '<p>html</p>' }))
    expect(detail.description).toBe('<p>html</p>')
    expect(detail.isRenderedHtml).toBe(true)
  })

  it('falls back to the raw wiki markup', () => {
    const detail = parseIssueDetail(raw({ description: 'h1. Title' }))
    expect(detail.description).toBe('h1. Title')
    expect(detail.isRenderedHtml).toBe(false)
  })

  it('does not treat an empty rendered description as HTML', () => {
    expect(parseIssueDetail(raw({ description: 'raw' }, { description: '' })).isRenderedHtml).toBe(false)
  })
})

describe('attachments', () => {
  it('keeps id, filename, content, thumbnail and type', () => {
    const detail = parseIssueDetail(raw({
      attachment: [{ id: '1', filename: 'a.png', content: '/c', thumbnail: '/t', mimeType: 'image/png' }],
    }))
    expect(detail.attachments).toEqual([
      { id: '1', filename: 'a.png', content: '/c', thumbnail: '/t', mimeType: 'image/png' },
    ])
  })

  it('fills missing attachment fields with empty strings', () => {
    const detail = parseIssueDetail(raw({ attachment: [{}] }))
    expect(detail.attachments[0]).toEqual({ id: '', filename: '', content: '', thumbnail: '', mimeType: '' })
  })
})

describe('people and metadata', () => {
  it('reads assignee and reporter with their 48px avatars', () => {
    const detail = parseIssueDetail(raw({
      assignee: { displayName: 'Ana', avatarUrls: { '48x48': '/ana.png' } },
      reporter: { displayName: 'Bea', avatarUrls: { '48x48': '/bea.png' } },
    }))
    expect(detail).toMatchObject({
      assignee: 'Ana', assigneeAvatar: '/ana.png', reporter: 'Bea', reporterAvatar: '/bea.png',
    })
  })

  it('reads the priority name', () => {
    expect(parseIssueDetail(raw({ priority: { name: 'High' } })).priority).toBe('High')
  })

  it('joins sprint names and drops the unnamed ones', () => {
    expect(parseIssueDetail(raw({ customfield_10020: [{ name: 'S1' }, {}, { name: 'S2' }] })).sprint)
      .toBe('S1, S2')
  })

  it('lists fix versions, dropping the unnamed ones', () => {
    expect(parseIssueDetail(raw({ fixVersions: [{ name: '1.0' }, {}] })).fixVersions).toEqual(['1.0'])
  })
})

describe('the estimate', () => {
  it('turns seconds into whole hours', () => {
    expect(parseIssueDetail(raw({ timeoriginalestimate: 7200 })).estimate).toBe('2h')
  })

  it('rounds to the nearest hour', () => {
    expect(parseIssueDetail(raw({ timeoriginalestimate: 5400 })).estimate).toBe('2h')
    expect(parseIssueDetail(raw({ timeoriginalestimate: 5000 })).estimate).toBe('1h')
  })

  it('shows nothing when there is no estimate', () => {
    expect(parseIssueDetail(raw({ timeoriginalestimate: 0 })).estimate).toBe('')
    expect(parseIssueDetail(raw()).estimate).toBe('')
  })
})

describe('parsePullRequests', () => {
  it('flattens the pull requests across detail entries', () => {
    const prs = parsePullRequests({
      detail: [
        { pullRequests: [{ title: 'One', url: '/1', status: 'OPEN' }] },
        { pullRequests: [{ title: 'Two', url: '/2', status: 'MERGED' }] },
      ],
    })
    expect(prs).toEqual([
      { title: 'One', url: '/1', status: 'OPEN' },
      { title: 'Two', url: '/2', status: 'MERGED' },
    ])
  })

  it('fills missing pull request fields with empty strings', () => {
    expect(parsePullRequests({ detail: [{ pullRequests: [{}] }] }))
      .toEqual([{ title: '', url: '', status: '' }])
  })

  it('returns nothing for an instance that does not report them', () => {
    expect(parsePullRequests(null)).toEqual([])
    expect(parsePullRequests({})).toEqual([])
    expect(parsePullRequests({ detail: [{}] })).toEqual([])
  })
})
