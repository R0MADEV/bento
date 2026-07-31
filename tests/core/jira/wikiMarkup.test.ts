import { describe, it, expect } from 'vitest'
import { jiraWikiToHtml } from '../../../src/core/jira/wikiMarkup'

describe('jiraWikiToHtml', () => {
  it('renders bullet lists', () => {
    const html = jiraWikiToHtml('* item one\n* item two')
    expect(html).toContain('<li>item one</li>')
    expect(html).toContain('<li>item two</li>')
    expect(html).toContain('<ul>')
  })

  it('renders nested bullets', () => {
    const html = jiraWikiToHtml('* parent\n** child')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>parent</li>')
    expect(html).toContain('<li>child</li>')
  })

  it('renders bold and italic inline', () => {
    expect(jiraWikiToHtml('hello *world*')).toContain('<strong>world</strong>')
    expect(jiraWikiToHtml('hello _world_')).toContain('<em>world</em>')
  })

  it('renders noformat block as code', () => {
    const html = jiraWikiToHtml('{noformat}\nsome code\n{noformat}')
    expect(html).toContain('<pre>')
    expect(html).toContain('some code')
  })

  it('renders links', () => {
    const html = jiraWikiToHtml('[Click here|https://example.com]')
    expect(html).toContain('<a')
    expect(html).toContain('https://example.com')
    expect(html).toContain('Click here')
  })

  it('renders headings', () => {
    expect(jiraWikiToHtml('h1. Title')).toContain('<h1>Title</h1>')
    expect(jiraWikiToHtml('h2. Section')).toContain('<h2>Section</h2>')
  })

  it('preserves plain text lines', () => {
    const html = jiraWikiToHtml('just plain text')
    expect(html).toContain('just plain text')
  })
})
