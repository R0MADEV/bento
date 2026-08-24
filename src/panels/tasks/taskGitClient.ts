import { invoke } from '@tauri-apps/api/core'
import type { CommitEntry, CommitFile, CommitRecommendation, GitStatus, WorktreeInfo } from '../../core/git/gitTypes'

const emptyStatus = (): GitStatus => ({ raw: '', staged: 0, unstaged: 0, untracked: 0, total: 0 })

export const taskGit = {
  worktrees: (repo: string): Promise<WorktreeInfo[]> => invoke<WorktreeInfo[]>('git_worktree_list', { repo }),
  status: (path: string): Promise<GitStatus> => invoke<GitStatus>('git_status', { path }),
  safeStatus: (path: string): Promise<GitStatus> => invoke<GitStatus>('git_status', { path }).catch(emptyStatus),
  remoteBranches: (repo: string): Promise<string[]> => invoke<string[]>('git_remote_branches', { repo }),
  log: (path: string, limit = 50): Promise<CommitEntry[]> =>
    invoke<CommitEntry[]>('git_log', { path, limit, noMerges: false }),
  rebaseLog: (path: string, base: string): Promise<CommitEntry[]> =>
    invoke<CommitEntry[]>('git_rebase_log', { path, base }),
  mergeLog: (path: string, base: string): Promise<CommitEntry[]> =>
    invoke<CommitEntry[]>('git_merge_log', { path, base }),
  files: (path: string, hash: string): Promise<CommitFile[]> =>
    invoke<CommitFile[]>('git_show_files', { path, hash }),
  recommendations: (path: string, base: string, files: string[]): Promise<CommitRecommendation[]> =>
    invoke<CommitRecommendation[]>('git_recommend_commits', { path, base, files }),
  blameRecommendations: (path: string, base: string, patch: string): Promise<CommitRecommendation[]> =>
    invoke<CommitRecommendation[]>('git_blame_recommend', { path, base, patch }),
}

export function commitFilesRaw(files: CommitFile[]): string {
  return files.map(file => [file.status, ...file.paths].join('\t')).join('\n')
}

export function recommendationMap(items: CommitRecommendation[]): Map<string, { score: number; files: string[] }> {
  return new Map(items.map(item => [item.hash, { score: item.score, files: item.files }]))
}
