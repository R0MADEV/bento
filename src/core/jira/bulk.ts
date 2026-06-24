export interface BulkIssue {
  summary: string
  description: string
}

// One issue per line: "summary" or "summary | description".
export function parseBulkIssues(text: string): BulkIssue[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const i = line.indexOf('|')
      if (i === -1) return { summary: line, description: '' }
      return { summary: line.slice(0, i).trim(), description: line.slice(i + 1).trim() }
    })
}
