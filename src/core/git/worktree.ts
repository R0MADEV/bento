export interface Worktree {
  path: string
  branch: string | null
  head: string
  bare: boolean
}

export interface StatusSummary {
  staged: number
  unstaged: number
  untracked: number
  total: number
}

/** Parses the output of `git worktree list --porcelain`. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  if (!porcelain.trim()) return []

  return porcelain
    .trim()
    .split(/\n\n+/)
    .flatMap(block => {
      const lines = block.trim().split('\n')
      const isBare = lines.some(l => l === 'bare')
      if (isBare) return []

      const pathLine = lines.find(l => l.startsWith('worktree '))
      const headLine = lines.find(l => l.startsWith('HEAD '))
      const branchLine = lines.find(l => l.startsWith('branch '))

      if (!pathLine || !headLine) return []

      return [{
        path: pathLine.slice('worktree '.length),
        head: headLine.slice('HEAD '.length),
        branch: branchLine ? branchLine.slice('branch refs/heads/'.length) : null,
        bare: false,
      }]
    })
}

/** Parses `git status --porcelain` (v1). */
export function parseStatus(porcelain: string): StatusSummary {
  const lines = porcelain.split('\n').filter(l => l.trim())

  let staged = 0, unstaged = 0, untracked = 0

  for (const line of lines) {
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '

    if (x === '?' && y === '?') {
      untracked++
      continue
    }
    if (x !== ' ') staged++
    if (y !== ' ') unstaged++
  }

  return { staged, unstaged, untracked, total: lines.length }
}

/** Sanitizes a task name into a branch name, e.g. "Login Form" → "feat/login-form". */
export function taskBranch(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[\s_/]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return `feat/${sanitized || 'task'}`
}

/** Derives the sibling worktree path: taskPath("/x/bento", "login") → "/x/bento-login". */
export function taskPath(repoPath: string, name: string): string {
  return `${repoPath.replace(/\/$/, '')}-${name}`
}
