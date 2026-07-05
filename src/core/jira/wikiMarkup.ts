// Converts Jira wiki markup to safe HTML.
// Handles: headings, bullet/numbered lists, bold, italic, links, noformat/code blocks, image refs.

export function jiraWikiToHtml(wiki: string, attachments: Map<string, string> = new Map()): string {
  // Process block-level elements first, then inline.
  const lines = wiki.split('\n')
  const out: string[] = []
  let inList = false
  let listDepth = 0
  let inCode = false
  let codeLines: string[] = []

  const closeList = (): void => {
    for (let i = listDepth; i > 0; i--) out.push('</ul>')
    inList = false
    listDepth = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // noformat / code block — check close before open so closing tag isn't re-interpreted as open
    if (inCode) {
      if (/^\{noformat\}|^\{code\}/.test(line)) {
        out.push(`<pre>${escHtml(codeLines.join('\n'))}</pre>`)
        inCode = false
        codeLines = []
      } else {
        codeLines.push(line)
      }
      continue
    }
    if (/^\{noformat\}|^\{code[^}]*\}/.test(line)) {
      if (inList) closeList()
      inCode = true
      codeLines = []
      continue
    }

    // Headings: h1. … h6.
    const heading = line.match(/^h([1-6])\.\s+(.+)$/)
    if (heading) {
      if (inList) closeList()
      out.push(`<h${heading[1]}>${inlineMarkup(heading[2], attachments)}</h${heading[1]}>`)
      continue
    }

    // Bullet lists: * ** *** (depth by number of *)
    const bullet = line.match(/^(\*+)\s+(.+)$/)
    if (bullet) {
      const depth = bullet[1].length
      if (!inList) { out.push('<ul>'); inList = true; listDepth = 1 }
      while (listDepth < depth) { out.push('<ul>'); listDepth++ }
      while (listDepth > depth) { out.push('</ul>'); listDepth-- }
      out.push(`<li>${inlineMarkup(bullet[2], attachments)}</li>`)
      continue
    }

    // Numbered lists: # ## ###
    const numbered = line.match(/^(#+)\s+(.+)$/)
    if (numbered) {
      const depth = numbered[1].length
      if (!inList) { out.push('<ol>'); inList = true; listDepth = 1 }
      while (listDepth < depth) { out.push('<ol>'); listDepth++ }
      while (listDepth > depth) { out.push('</ol>'); listDepth-- }
      out.push(`<li>${inlineMarkup(numbered[2], attachments)}</li>`)
      continue
    }

    // Close list on non-list line
    if (inList) closeList()

    // Horizontal rule
    if (/^----/.test(line)) { out.push('<hr>'); continue }

    // Empty line → paragraph break
    if (!line.trim()) { out.push('<br>'); continue }

    out.push(`<p>${inlineMarkup(line, attachments)}</p>`)
  }

  if (inCode) out.push(`<pre>${escHtml(codeLines.join('\n'))}</pre>`)
  if (inList) closeList()

  return out.join('\n')
}

function inlineMarkup(text: string, attachments: Map<string, string>): string {
  let s = escHtml(text)
  // Links: [text|url] or [url]
  s = s.replace(/\[([^\]|]+)\|([^\]]+)\]/g, (_, label, url) =>
    `<a href="#" data-href="${escAttr(url)}" class="jira-wiki-link">${label}</a>`)
  s = s.replace(/\[([^\]]+)\]/g, (_, url) =>
    url.startsWith('http') ? `<a href="#" data-href="${escAttr(url)}" class="jira-wiki-link">${url}</a>` : `[${url}]`)
  // Image attachments: !filename.png! or !filename.png|width=...!
  s = s.replace(/!([^!|]+?)(?:\|[^!]*)?\[?[^\]]*\]?!/g, (_, filename) => {
    const url = attachments.get(filename.trim())
    if (url) return `<img src="${escAttr(url)}" alt="${escAttr(filename)}" class="jira-wiki-img">`
    return `<span class="jira-wiki-attachment">📎 ${escHtml(filename)}</span>`
  })
  // Bold: *text* (not at line start to avoid conflict with bullets — already escaped)
  s = s.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
  // Italic: _text_
  s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>')
  // Monospace: {{text}}
  s = s.replace(/\{\{([^}]+)\}\}/g, '<code>$1</code>')
  return s
}

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escAttr = (s: string): string =>
  s.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
