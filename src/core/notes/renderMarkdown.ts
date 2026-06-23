function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Inline formatting on already-escaped text. Split out code spans and format only
// the parts outside them, so their content isn't reformatted (collision-proof).
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map(part => {
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${part.slice(1, -1)}</code>`
      }
      return part
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) =>
          /^(https?:\/\/|mailto:|\/|#)/.test(url) ? `<a href="${url}">${label}</a>` : m)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    })
    .join('')
}

// Minimal, safe Markdown → HTML: headings (1-3), unordered lists, paragraphs +
// inline (bold/italic/code/links). Input is escaped first, so it can't inject HTML.
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md).split('\n')
  const out: string[] = []
  let inList = false
  const closeList = (): void => { if (inList) { out.push('</ul>'); inList = false } }

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      closeList()
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const item = line.match(/^[-*]\s+(.*)$/)
    if (item) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(item[1])}</li>`)
      continue
    }
    closeList()
    if (line.trim() !== '') out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('\n')
}
