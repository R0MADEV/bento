import { invoke } from '@tauri-apps/api/core'
import type { CommitEntry, CommitFile, GitStatus } from '../../core/git/gitTypes'

export const diffGit = {
  diff: (path: string): Promise<string> =>
    invoke<string>('git_diff', { path }),
  branchDiff: (path: string, base: string): Promise<string> =>
    invoke<string>('git_branch_diff', { path, base }),
  defaultBranch: (repo: string): Promise<string> =>
    invoke<string>('git_default_branch', { repo }).catch(() => 'main'),
  remoteBranches: (repo: string): Promise<string[]> =>
    invoke<string[]>('git_all_remote_branches', { repo }).catch(() => []),
  reviewBranches: (repo: string): Promise<string[]> =>
    invoke<string[]>('git_review_branches', { repo }).catch(() => []),
  currentBranch: (path: string): Promise<string> =>
    invoke<string>('git_current_branch', { path }).catch(() => ''),
  reviewWorktreeDiff: (path: string, base: string): Promise<string> =>
    invoke<string>('git_review_worktree_diff', { path, base }),
  status: (path: string): Promise<GitStatus> =>
    invoke<GitStatus>('git_status', { path }),
  log: (path: string, limit = 100): Promise<CommitEntry[]> =>
    invoke<CommitEntry[]>('git_log', { path, limit, noMerges: false }),
  files: (path: string, hash: string): Promise<CommitFile[]> =>
    invoke<CommitFile[]>('git_show_files', { path, hash }),
  showDiff: (path: string, hash: string, file: string): Promise<string> =>
    invoke<string>('git_show_commit_diff', { path, hash, file }),
  showFile: (path: string, hash: string, file: string): Promise<string> =>
    invoke<string>('git_show_file', { path, hash, file }),
}
