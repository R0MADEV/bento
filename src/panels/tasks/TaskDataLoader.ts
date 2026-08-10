import { invoke } from '@tauri-apps/api/core'
import type { Worktree } from '../../core/git/worktree'
import { parseContainers, isRunning } from '../../core/docker/containers'
import { extractIssueKey, parseAheadBehind } from '../../core/git/taskJira'
import { mapWithConcurrency } from '../../core/git/rebaseWorkflow'
import { loadJiraConfig, fetchIssue, type JiraConfig, type TaskIssue } from './taskJiraClient'
import type { BackupStatus, PrStatus, RebaseStatus, UpstreamStatus } from './gitTypes'
import { taskT } from './i18n'
import { taskGit } from './taskGitClient'

export async function loadTaskData(options: {
  repoPath: string
  panelStore: { savedBase: () => string | null; setBase: (base: string) => void; selected: () => string | null; setSelected: (path: string) => void }
  baseSelect: HTMLSelectElement
  filterInput: HTMLInputElement
  listWrap: HTMLElement
  fetchAgeEl: HTMLElement
  note: (text: string, cls?: string) => HTMLElement
  setBaseBranch: (base: string) => void
  setWorktrees: (items: Worktree[]) => void
  setJiraConfig: (config: JiraConfig | null) => void
  maps: {
    issue: Map<string, TaskIssue | null>
    aheadBehind: Map<string, { ahead: number; behind: number }>
    pr: Map<string, PrStatus | null>
    backup: Map<string, BackupStatus>
    rebase: Map<string, RebaseStatus>
    upstream: Map<string, UpstreamStatus>
  }
  renderList: (statuses: Map<string, number>, runningPaths: Set<string>) => void
  selectRow: (row: HTMLElement) => void
  showChanges: (wt: Worktree) => void
  showRebasePaused: (wt: Worktree, status: RebaseStatus) => void
}): Promise<void> {
  const { repoPath, panelStore, baseSelect, filterInput, listWrap, fetchAgeEl, note, setBaseBranch, setWorktrees, setJiraConfig, maps, renderList, selectRow, showChanges, showRebasePaused } = options
  baseSelect.disabled = false
  filterInput.style.display = ''
  listWrap.replaceChildren(note(taskT('loading'), 'db-detail-loading'))
  try {
    const [defaultBranch, remoteBranches] = await Promise.all([
      invoke<string>('git_default_branch', { repo: repoPath }).catch(() => 'main'),
      taskGit.remoteBranches(repoPath).catch(() => [] as string[]),
    ])
    if (!remoteBranches.includes(defaultBranch)) remoteBranches.unshift(defaultBranch)
    const savedBase = panelStore.savedBase()
    const baseBranch = savedBase && remoteBranches.includes(savedBase) ? savedBase : defaultBranch
    panelStore.setBase(baseBranch); setBaseBranch(baseBranch)
    baseSelect.replaceChildren(...remoteBranches.map(branch => Object.assign(document.createElement('option'), { value: branch, textContent: taskT('baseOption', { branch }), selected: branch === baseBranch })))
    const worktrees = await taskGit.worktrees(repoPath)
    setWorktrees(worktrees)
    const fetchedAt = worktrees[0] ? (await invoke<{ fetchedAt: number }>('git_fetch_info', { path: worktrees[0].path }).catch(() => ({ fetchedAt: 0 }))).fetchedAt : 0
    if (fetchedAt) {
      const ageMinutes = Math.max(0, Math.floor((Date.now() / 1000 - fetchedAt) / 60))
      fetchAgeEl.textContent = ageMinutes < 1 ? taskT('fetchNow') : ageMinutes < 60 ? taskT('fetchMinutes', { count: ageMinutes }) : taskT('fetchHours', { count: Math.floor(ageMinutes / 60) })
      fetchAgeEl.classList.toggle('tasks-fetch-age--stale', ageMinutes > 60); fetchAgeEl.title = new Date(fetchedAt * 1000).toLocaleString()
    } else { fetchAgeEl.textContent = taskT('noFetch'); fetchAgeEl.classList.add('tasks-fetch-age--stale') }
    const jiraCfg = await loadJiraConfig(); setJiraConfig(jiraCfg)
    const [statuses, allContainers] = await Promise.all([
      mapWithConcurrency(worktrees, 6, async wt => [wt.path, (await taskGit.safeStatus(wt.path)).total] as [string, number]).then(entries => new Map(entries)),
      invoke<string>('docker_list').catch(() => '').then(parseContainers),
    ])
    await mapWithConcurrency(worktrees, 4, async wt => {
      maps.aheadBehind.set(wt.path, parseAheadBehind(await invoke<string>('git_ahead_behind', { path: wt.path, base: baseBranch }).catch(() => '')))
      const key = extractIssueKey(wt.branch ?? null)
      maps.issue.set(wt.path, key && jiraCfg ? await fetchIssue(key, jiraCfg) : null)
      maps.pr.set(wt.path, await invoke<PrStatus | null>('git_pr_status', { path: wt.path }).catch(() => null))
      maps.backup.set(wt.path, await invoke<BackupStatus>('git_backup_status', { path: wt.path }).catch(() => ({ available: false, different: null, hash: null, short: null, subject: null })))
      maps.rebase.set(wt.path, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false } as RebaseStatus)))
      const upstream = await invoke<UpstreamStatus | null>('git_upstream_status', { path: wt.path }).catch(() => null)
      if (upstream) maps.upstream.set(wt.path, upstream); else maps.upstream.delete(wt.path)
    })
    const runningPaths = new Set<string>()
    worktrees.forEach(wt => {
      const dir = wt.path.replace(/\/$/, '').split('/').pop()!
      if (allContainers.some(c => isRunning(c) && c.name.startsWith(`${dir}-`))) runningPaths.add(wt.path)
    })
    renderList(statuses, runningPaths)
    const savedPath = panelStore.selected()
    const selectedWt = worktrees.find(w => maps.rebase.get(w.path)?.active) ?? (savedPath ? worktrees.find(w => w.path === savedPath) : undefined)
    if (selectedWt) {
      const rows = listWrap.querySelectorAll<HTMLElement>('.tasks-row')
      const row = [...rows].find(item => item.dataset.path === selectedWt.path)
      if (row) {
        selectRow(row); panelStore.setSelected(selectedWt.path)
        const rebase = maps.rebase.get(selectedWt.path)
        if (rebase?.active) showRebasePaused(selectedWt, rebase); else showChanges(selectedWt)
      }
    }
  } catch (error) { listWrap.replaceChildren(note(String(error), 'db-detail-error')) }
}
