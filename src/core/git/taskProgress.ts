// Aggregate health of a repo's worktrees, shown as progress bars in the sidebar
// footer. Pure so it can be unit-tested. Unknown status (data not loaded yet) is
// counted as clean/synced so the bars don't flash red on first paint.

export interface TaskProgress {
  clean: { done: number; total: number }
  synced: { done: number; total: number }
}

export function taskProgress(
  worktrees: readonly { path: string }[],
  changes: Map<string, number>,
  aheadBehind: Map<string, { ahead: number; behind: number }>,
): TaskProgress {
  const total = worktrees.length
  let clean = 0
  let synced = 0
  for (const wt of worktrees) {
    if ((changes.get(wt.path) ?? 0) === 0) clean++
    if ((aheadBehind.get(wt.path)?.behind ?? 0) === 0) synced++
  }
  return { clean: { done: clean, total }, synced: { done: synced, total } }
}
