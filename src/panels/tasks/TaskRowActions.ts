import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import type { MenuItem } from '../../ui/contextMenu'
import type { Worktree } from '../../core/git/worktree'
import type { BackupStatus, PrStatus, RebaseStatus } from './gitTypes'
import { taskT } from './i18n'

export function taskRowActions(options: {
  worktree: Worktree
  row: HTMLElement
  isMain: boolean
  baseBranch: string
  ahead: number
  hasPr: boolean
  issue: boolean
  jiraConfigured: boolean
  pr: PrStatus | null
  backup: BackupStatus | undefined
  rebase: RebaseStatus | undefined
  selectRow: (row: HTMLElement) => void
  showRebasePaused: (wt: Worktree, status: RebaseStatus) => void
  showChanges: (wt: Worktree) => void
  showHistory: (wt: Worktree) => void
  showGraph: (wt: Worktree) => void
  showInteractiveRebase: (wt: Worktree) => void
  showTerminal: (wt: Worktree) => void
  showPrDetails: (wt: Worktree, pr: PrStatus) => void
  showReset: (wt: Worktree) => void
  showBackups: (wt: Worktree) => void
  showOperations: (wt: Worktree) => void
  isolateDocker: (wt: Worktree) => void
  runSync: (mode: 'fetch' | 'merge' | 'rebase') => void
  copyBranch: () => void
  openJira: () => void
  changeJiraStatus: () => void
  push: () => void
  createPr: () => void
  restoreBackup: () => void
  rename: () => void
  deleteTask: () => void
  setBase: (branch: string) => void
  reload: () => void
}): MenuItem[] {
  const { worktree: wt, row, isMain, baseBranch, ahead, hasPr, issue, jiraConfigured, pr, backup, rebase } = options
  const select = options.selectRow
  const items: MenuItem[] = [
    ...(rebase?.active ? [{ label: taskT('continueRebaseMenu', { progress: rebase.total ? ` · ${rebase.current ?? 0}/${rebase.total}` : '' }), onClick: () => { select(row); options.showRebasePaused(wt, rebase) } }] : []),
    { label: taskT('viewChanges'), onClick: () => { select(row); options.showChanges(wt) } },
    { label: taskT('viewHistory'), onClick: () => { select(row); options.showHistory(wt) } },
    { label: taskT('viewGraph'), onClick: () => { select(row); options.showGraph(wt) } },
    { label: taskT('interactiveRebase'), onClick: () => { select(row); options.showInteractiveRebase(wt) } },
    { label: taskT('openEditor'), onClick: () => { invoke('open_in_editor', { path: wt.path }).catch(console.error) } },
    { label: taskT('terminal'), onClick: () => { select(row); options.showTerminal(wt) } },
    { label: taskT('copyBranch'), onClick: options.copyBranch },
  ]
  if (issue && jiraConfigured) items.push({ label: taskT('openJira'), onClick: options.openJira }, { label: taskT('changeStatus'), onClick: options.changeJiraStatus })
  if (pr?.baseRefName && pr.baseRefName !== baseBranch) items.push({ label: taskT('usePrBase', { branch: pr.baseRefName }), onClick: () => { options.setBase(pr.baseRefName!); options.reload() } })
  if (isMain) return items
  items.push(
    { label: taskT('docker'), onClick: () => { select(row); options.isolateDocker(wt) } },
    { label: taskT('fetch'), onClick: () => options.runSync('fetch') },
    { label: taskT('mergeOrigin', { branch: baseBranch }), onClick: () => options.runSync('merge') },
    { label: taskT('rebaseOrigin', { branch: baseBranch }), onClick: () => options.runSync('rebase') },
    { label: taskT('push'), onClick: options.push },
  )
  if (ahead > 0 && !hasPr) items.push({ label: taskT('createPrFor', { base: baseBranch }), onClick: options.createPr })
  if (pr?.url) items.push({ label: taskT('viewPr'), onClick: () => openUrl(pr.url).catch(() => {}) }, { label: taskT('prChecks'), onClick: () => { select(row); options.showPrDetails(wt, pr) } })
  items.push(
    { label: taskT('resetToOrigin', { branch: baseBranch }), onClick: () => { select(row); options.showReset(wt) } },
    { label: taskT('backups'), testId: 'tasks-backups-action', onClick: () => { select(row); options.showBackups(wt) } },
    { label: taskT('operations'), onClick: () => { select(row); options.showOperations(wt) } },
    ...(backup?.available && backup.different ? [{ label: taskT('undoRewriteBackup', { short: backup.short ?? taskT('backup') }), onClick: options.restoreBackup }] : []),
    { label: taskT('rename'), onClick: options.rename },
    { label: taskT('deleteTask'), onClick: options.deleteTask },
  )
  return items
}
