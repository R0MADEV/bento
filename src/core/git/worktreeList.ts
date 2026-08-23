import type { Worktree } from './worktree'

/** The worktrees matching a free-text query against their branch or path. */
export function filterWorktrees(worktrees: Worktree[], query: string): Worktree[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return worktrees
  return worktrees.filter(wt =>
    (wt.branch ?? '').toLowerCase().includes(needle) || wt.path.toLowerCase().includes(needle))
}

/**
 * Worktrees bucketed under the repository they belong to, both repos and
 * worktrees kept in the order they appear. A worktree with no recorded repo
 * falls back to the panel's current one.
 */
export function groupWorktreesByRepo(
  worktrees: Worktree[], repoOf: Map<string, string>, fallbackRepo: string,
): Map<string, Worktree[]> {
  const byRepo = new Map<string, Worktree[]>()
  for (const wt of worktrees) {
    const repo = repoOf.get(wt.path) ?? fallbackRepo
    const bucket = byRepo.get(repo) ?? []
    bucket.push(wt)
    byRepo.set(repo, bucket)
  }
  return byRepo
}
