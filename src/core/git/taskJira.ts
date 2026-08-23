export function extractIssueKey(branch: string | null): string | null {
  if (!branch) return null
  const match = branch.match(/[A-Z][A-Z0-9]+-\d+/)
  return match?.[0] ?? null
}

// Parses the output of `git rev-list --left-right --count origin/<base>...HEAD`.
// Format: "<left>\t<right>" where left = behind (commits in base not in HEAD),
// right = ahead (commits in HEAD not in base).
export function parseAheadBehind(output: string): { behind: number; ahead: number } {
  const parts = output.trim().split(/[\t ]/)
  const behind = parseInt(parts[0] ?? '', 10)
  const ahead = parseInt(parts[1] ?? '', 10)
  if (isNaN(behind) || isNaN(ahead)) return { behind: 0, ahead: 0 }
  return { behind, ahead }
}
