export interface ParsedNote {
  title: string
  category: string
  tags: string[]
  body: string
}

function parseFrontmatter(fm: string): Partial<ParsedNote> {
  const out: Partial<ParsedNote> = {}
  for (const line of fm.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === 'title') out.title = value
    else if (key === 'category') out.category = value
    else if (key === 'tags') out.tags = value.split(',').map(t => t.trim()).filter(Boolean)
  }
  return out
}

// Markdown with optional YAML-ish frontmatter (title/category/tags). Without
// frontmatter, the first non-empty line is used as the title.
export function parseNote(markdown: string): ParsedNote {
  if (markdown.startsWith('---\n')) {
    const end = markdown.indexOf('\n---\n', 4)
    if (end !== -1) {
      const meta = parseFrontmatter(markdown.slice(4, end))
      return {
        title: meta.title ?? '',
        category: meta.category ?? '',
        tags: meta.tags ?? [],
        body: markdown.slice(end + 5),
      }
    }
  }
  const firstLine = markdown.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return { title: firstLine, category: '', tags: [], body: markdown }
}

export function serializeNote(note: ParsedNote): string {
  return `---\ntitle: ${note.title}\ncategory: ${note.category}\ntags: ${note.tags.join(', ')}\n---\n${note.body}`
}
