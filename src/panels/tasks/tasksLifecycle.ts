import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import { taskBranch, taskPath, type Worktree } from '../../core/git/worktree'
import { extractIssueKey, parseAheadBehind } from '../../core/git/taskJira'
import { fetchIssue, loadJiraConfig } from './taskJiraClient'
import type { BackupStatus, PrStatus, RebaseStatus, UpstreamStatus } from './gitTypes'
import { taskT } from './i18n'
import { taskGit } from './taskGitClient'
import type { IsolateResult } from './TaskDockerView'
import { loadTaskData } from './TaskDataLoader'
import { isRunning, parseContainers } from '../../core/docker/containers'
import type { TasksPanelCtx } from './tasksPanelContext'
import { baseFor, prepareTaskDevcontainer, repositoryFor, selectRow, selectWorktree } from './tasksPanelContext'
import { note, showDetail } from './tasksPanelHelpers'
import { renderList, refreshCreateForm } from './tasksListView'
import { showChanges } from './tasksDetailViews'
import { showRebasePaused } from './tasksRebaseView'

// ---- mutations ----
export async function createTask(ctx: TasksPanelCtx, name: string, repository = ctx.repoPath): Promise<void> {
  if (!name || !repository) return
  const branch = taskBranch(name)
  const path = taskPath(repository, branch.slice('feat/'.length))
  ctx.listWrap.replaceChildren(note(taskT('creatingTask'), 'db-detail-loading'))
  try {
    const base = await invoke<string>('git_default_branch', { repo: repository })
    await invoke('git_worktree_add', { repo: repository, path, branch, base })
    await load(ctx)
    const wt = ctx.worktrees.find(w => w.path === path)
    const row = [...ctx.listWrap.querySelectorAll<HTMLElement>('.tasks-row')].find(item => item.dataset.path === path)
    if (wt && row) {
      selectWorktree(ctx, row, wt)
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    try {
      const result = await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: path })
      if (wt) ctx.dockerView.show(result, wt)
    } catch (e) {
      // No root docker-compose.yml → maybe a devcontainer project (compose under .devcontainer/).
      if (String(e) !== 'no-compose') { showDetail(ctx, note(String(e), 'db-detail-error')); return }
      if (wt) {
        const prepared = await prepareTaskDevcontainer(ctx, wt)
        if (!prepared) void showChanges(ctx, wt)
      }
    }
  } catch (e) { ctx.listWrap.replaceChildren(note(String(e), 'db-detail-error')) }
}

export async function deleteWorktree(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  const { total } = await taskGit.safeStatus(wt.path)
  const ok = await askConfirm(
    total > 0 ? taskT('deleteDirtyQuestion', { branch: wt.branch ?? '', count: total }) : taskT('deleteQuestion', { branch: wt.branch ?? '' }),
    { title: taskT('deleteTask'), kind: total > 0 ? 'warning' : 'info' },
  )
  if (!ok) return
  try {
    await invoke('docker_compose_down', { worktreePath: wt.path }).catch(() => {})
    await invoke('git_worktree_remove', { repo: repositoryFor(ctx, wt), path: wt.path, force: total > 0, branch: wt.branch ?? null })
    // Tear down the worktree's live agents hub (its worktree is gone) and drop
    // its persisted agents + scrollback so nothing is left orphaned.
    ctx.worktreeTerminals.get(wt.path)?.dispose()
    ctx.worktreeTerminals.delete(wt.path)
    try { localStorage.removeItem(`bento.agents.wt:${wt.path}.sessions`) } catch { /* ignore */ }
    void invoke('agent_history_clear', { scope: `bento.agents.wt:${wt.path}` }).catch(() => {})
    showDetail(ctx, note(taskT('selectTask'), 'db-detail-hint'))
    await load(ctx)
  } catch (e) { await askConfirm(String(e), { title: taskT('genericError'), kind: 'error' }) }
}

// ---- load ----
export async function loadMultiRepo(ctx: TasksPanelCtx, repos: string[]): Promise<void> {
  ctx.listWrap.replaceChildren(note(taskT('loading'), 'db-detail-loading'))
  ctx.repoOf.clear()
  ctx.baseOf.clear()
  ;[ctx.issueMap, ctx.prStatusMap, ctx.backupStatusMap, ctx.rebaseStatusMap, ctx.upstreamStatusMap].forEach(m => m.clear())
  ctx.aheadBehindMap.clear()
  try {
    const [repoData, containers, config] = await Promise.all([
      Promise.all(repos.map(async repo => ({
        repo,
        base: await invoke<string>('git_default_branch', { repo }).catch(() => 'main'),
        worktrees: await taskGit.worktrees(repo),
      }))),
      invoke<string>('docker_list').catch(() => '').then(parseContainers),
      loadJiraConfig(),
    ])
    ctx.jiraCfg = config
    ctx.worktrees = repoData.flatMap(({ repo, base, worktrees: items }) => {
      items.forEach(wt => {
        ctx.repoOf.set(wt.path, repo)
        ctx.baseOf.set(wt.path, base)
      })
      return items
    })
    const statuses = new Map<string, number>()
    await Promise.all(ctx.worktrees.map(async wt => {
      const base = baseFor(ctx, wt)
      const key = extractIssueKey(wt.branch ?? null)
      const [status, aheadBehind, issue, pr, backup, rebase, upstream] = await Promise.all([
        taskGit.safeStatus(wt.path),
        invoke<string>('git_ahead_behind', { path: wt.path, base }).catch(() => ''),
        key && ctx.jiraCfg ? fetchIssue(key, ctx.jiraCfg) : null,
        invoke<PrStatus | null>('git_pr_status', { path: wt.path }).catch(() => null),
        invoke<BackupStatus>('git_backup_status', { path: wt.path }).catch(() => ({ available: false, different: null, hash: null, short: null, subject: null })),
        invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false } as RebaseStatus)),
        invoke<UpstreamStatus | null>('git_upstream_status', { path: wt.path }).catch(() => null),
      ])
      statuses.set(wt.path, status.total)
      ctx.aheadBehindMap.set(wt.path, parseAheadBehind(aheadBehind))
      ctx.issueMap.set(wt.path, issue)
      ctx.prStatusMap.set(wt.path, pr)
      ctx.backupStatusMap.set(wt.path, backup)
      ctx.rebaseStatusMap.set(wt.path, rebase)
      if (upstream) ctx.upstreamStatusMap.set(wt.path, upstream)
    }))
    const runningPaths = new Set(ctx.worktrees.filter(wt => {
      const directory = wt.path.replace(/\/$/, '').split('/').pop()!
      return containers.some(container => isRunning(container) && container.name.startsWith(`${directory}-`))
    }).map(wt => wt.path))
    renderList(ctx, statuses, runningPaths)
  } catch (error) {
    ctx.listWrap.replaceChildren(note(String(error), 'db-detail-error'))
  }
}

export async function load(ctx: TasksPanelCtx): Promise<void> {
  const repos = ctx.panelStore.repositories()
  if (repos.length === 0) {
    ctx.baseSelect.disabled = true
    ctx.filterInput.style.display = 'none'
    ctx.baseRow.style.display = 'none'
    ctx.repoPath = ''
    ctx.updateRepoBtn()
    ctx.removeRepoBtn.style.display = 'none'
    refreshCreateForm(ctx)
    ctx.listWrap.replaceChildren(note(taskT('selectRepoHint')))
    return
  }
  // Protect the principal repo: only offer to remove it when another repo
  // remains, so a stray click can never leave Bento with no repositories.
  ctx.removeRepoBtn.style.display = repos.length > 1 ? '' : 'none'
  ctx.repoPath = repos[0]!
  if (!repos.includes(ctx.selectedRepositoryPath)) ctx.selectedRepositoryPath = ctx.repoPath
  ctx.updateRepoBtn()
  if (repos.length > 1) {
    ctx.filterInput.style.display = ''
    ctx.baseRow.style.display = 'none'
    await loadMultiRepo(ctx, repos)
    return
  }
  ctx.baseSelect.disabled = false
  ctx.baseRow.style.display = ''
  const selectionVersionAtLoad = ctx.selectionVersion
  await loadTaskData({
    repoPath: ctx.repoPath,
    panelStore: ctx.panelStore,
    baseSelect: ctx.baseSelect,
    filterInput: ctx.filterInput,
    listWrap: ctx.listWrap,
    fetchAgeEl: ctx.fetchAgeEl,
    note,
    setBaseBranch: value => { ctx.baseBranch = value },
    setWorktrees: value => { ctx.worktrees = value },
    setJiraConfig: value => { ctx.jiraCfg = value },
    maps: { issue: ctx.issueMap, aheadBehind: ctx.aheadBehindMap, pr: ctx.prStatusMap, backup: ctx.backupStatusMap, rebase: ctx.rebaseStatusMap, upstream: ctx.upstreamStatusMap },
    renderList: (statuses, runningPaths) => renderList(ctx, statuses, runningPaths),
    shouldRestoreSelection: () => ctx.selectionVersion === selectionVersionAtLoad,
    selectRow: row => selectRow(ctx, row),
    showChanges: wt => void showChanges(ctx, wt),
    showRebasePaused: (wt, st) => showRebasePaused(ctx, wt, st),
  })
  ctx.repoOf.clear()
  ctx.baseOf.clear()
  ctx.worktrees.forEach(w => {
    ctx.repoOf.set(w.path, ctx.repoPath)
    ctx.baseOf.set(w.path, ctx.baseBranch)
  })
}
