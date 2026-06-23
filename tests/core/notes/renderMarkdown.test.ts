import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '../../../src/core/notes/renderMarkdown'

describe('renderMarkdown', () => {
  it('renders ATX headings (levels 1-3)', () => {
    expect(renderMarkdown('# Uno')).toContain('<h1>Uno</h1>')
    expect(renderMarkdown('## Dos')).toContain('<h2>Dos</h2>')
    expect(renderMarkdown('### Tres')).toContain('<h3>Tres</h3>')
  })

  it('renders bold, italic and inline code', () => {
    expect(renderMarkdown('un **fuerte** y *suave* y `cod`')).toContain('<strong>fuerte</strong>')
    expect(renderMarkdown('*suave*')).toContain('<em>suave</em>')
    expect(renderMarkdown('`cod`')).toContain('<code>cod</code>')
  })

  it('renders unordered lists', () => {
    const html = renderMarkdown('- uno\n- dos')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>uno</li>')
    expect(html).toContain('<li>dos</li>')
  })

  it('renders links', () => {
    expect(renderMarkdown('[bento](https://x.com)')).toContain('<a href="https://x.com">bento</a>')
  })

  it('wraps plain lines in paragraphs', () => {
    expect(renderMarkdown('hola mundo')).toContain('<p>hola mundo</p>')
  })

  it('escapes HTML to prevent injection', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('does not format inside inline code', () => {
    expect(renderMarkdown('`**no**`')).toContain('<code>**no**</code>')
  })
})
