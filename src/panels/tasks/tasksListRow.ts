import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { applyFilter } from './tasksListView'
import { summarisePrChecks } from '../../core/git/prChecks'
import { showContextMenu } from '../../ui/contextMenu'
import { statusCategoryClass } from '../../core/jira/board'
import { fetchIssue, fetchTransitions, applyTransition, browseUrl } from './taskJiraClient'
import type { RecipeApplyResult } from './TaskDockerView'
import type { RewritePreflight } from '../../core/git/gitTypes'
import { taskT } from './i18n'
import { taskGit } from './taskGitClient'
import { taskRowActions } from './TaskRowActions'
import type { TasksPanelCtx } from './tasksPanelContext'
import {
  baseFor, isCurrentSelection, prepareTaskDevcontainer, recordOperation,
  selectRow, selectWorktree, } from './tasksPanelContext'
import { iconBtn, note, showDetail } from './tasksPanelHelpers'
import { showBackupHistory, showCommitLog, showCommitGraph, showOperationHistory, showPrDetails, showResetView, showSyncError, showWorktreeTerminal } from './tasksDetailViews'
import { showChanges } from './tasksDiffView'
import { showInteractiveRebase, showRebasePaused } from './tasksRebaseView'
import { deleteWorktree, load } from './tasksLifecycle'

// ---- list ----

// Una fila de la lista: nombre, estado, y todas las acciones que caben en
// ella. Ocupaba más que el resto de la lista junta.

export function buildRow(ctx: TasksPanelCtx, wt: Worktree, isMain: boolean, changes: number, hasRunning: boolean): HTMLElement {
  const worktreeBase = baseFor(ctx, wt)
  const row = document.createElement('div')
  row.className = 'tasks-row'
  row.dataset.testid = 'tasks-row'
  row.dataset.branch = wt.branch ?? ''
  row.dataset.path = wt.path
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-label', `${taskT('tasks')}: ${wt.branch ?? ''}, ${taskT('changes', { count: changes })}`)

  const runDot = document.createElement('span')
  runDot.className = `tasks-run-dot ${hasRunning ? 'docker-up' : ''}`
  runDot.title = hasRunning ? taskT('containersRunning') : taskT('noContainers')

  const issue = ctx.issueMap.get(wt.path) ?? null
  const ab = ctx.aheadBehindMap.get(wt.path)
  const pr = ctx.prStatusMap.get(wt.path) ?? null
  const backup = ctx.backupStatusMap.get(wt.path)
  const rebase = ctx.rebaseStatusMap.get(wt.path)
  const upstream = ctx.upstreamStatusMap.get(wt.path)

  const branchEl = Object.assign(document.createElement('span'), {
    className: 'tasks-branch',
    textContent: wt.branch ?? taskT('detached'),
  })
  if (isMain) branchEl.title = taskT('mainWorktree')

  const pathEl = Object.assign(document.createElement('span'), {
    className: 'tasks-path',
    textContent: wt.path.replace(/\/$/, '').split('/').slice(-2).join('/'),
    title: wt.path,
  })

  const left = document.createElement('div')
  left.className = 'tasks-row-left'

  if (issue) {
    const issueEl = document.createElement('div')
    issueEl.className = 'tasks-issue-line'
    const keyEl = Object.assign(document.createElement('span'), { className: 'tasks-issue-key', textContent: issue.key })
    const sepEl = Object.assign(document.createElement('span'), { className: 'tasks-issue-sep', textContent: ' · ' })
    const summaryEl = Object.assign(document.createElement('span'), { className: 'tasks-issue-summary', textContent: issue.summary })
    const chipEl = Object.assign(document.createElement('span'), {
      className: `jira-status ${statusCategoryClass(issue.statusCategory)}`,
      textContent: issue.statusName,
    })
    issueEl.append(keyEl, sepEl, summaryEl, chipEl)
    left.append(issueEl, branchEl, pathEl)
  } else {
    left.append(branchEl, pathEl)
  }

  const badge = Object.assign(document.createElement('span'), {
    className: `tasks-badge${changes > 0 ? ' tasks-badge--dirty' : ''}`,
    textContent: changes > 0 ? taskT('changes', { count: changes }) : taskT('clean'),
  })
  const recipeEl = document.createElement('span')
  if (!isMain) {
    void invoke<RecipeApplyResult | null>('devcontainer_recipe_status', {
      worktreePath: wt.path,
      devcontainerDir: ctx.panelStore.devcontainerDir(),
    }).then(recipe => {
      if (!recipe || !row.isConnected) return
      recipeEl.className = `tasks-recipe-badge${recipe.errors.length ? ' tasks-recipe-badge--error' : ''}`
      recipeEl.textContent = taskT('recipeBadge')
      recipeEl.title = taskT('recipeBadgeTitle', {
        project: recipe.projectKey,
        applied: recipe.applied.length,
        errors: recipe.errors.length,
        date: new Date(recipe.appliedAt * 1000).toLocaleString(),
      })
    }).catch(() => {})
  }

  const flashBadge = (text: string, cls: string, ms: number): void => {
    const prev = badge.textContent ?? ''
    const prevCls = badge.className
    badge.textContent = text.split('\n')[0]?.slice(0, 28) ?? ''
    badge.className = `tasks-badge ${cls}`
    setTimeout(() => { badge.textContent = prev; badge.className = prevCls }, ms)
  }

  // Ahead/behind indicator — orange when behind (needs sync)
  const abEl = document.createElement('span')
  abEl.className = 'tasks-ahead-behind'
  if (ab && (ab.ahead > 0 || ab.behind > 0)) {
    if (ab.behind > 0) abEl.classList.add('tasks-behind')
    const parts: string[] = []
    if (ab.ahead > 0) parts.push(`↑${ab.ahead}`)
    if (ab.behind > 0) parts.push(`↓${ab.behind}`)
    abEl.textContent = parts.join(' ')
    abEl.title = taskT('aheadBehindTitle', { ahead: ab.ahead, behind: ab.behind, branch: worktreeBase })
  }

  // PR status badge
  const prEl = document.createElement('span')
  if (pr) {
    const stateMap: Record<string, string> = { OPEN: 'tasks-pr-open', DRAFT: 'tasks-pr-draft', MERGED: 'tasks-pr-merged', CLOSED: 'tasks-pr-closed' }
    const labelMap: Record<string, string> = {
      OPEN: taskT('openPrShort'),
      DRAFT: taskT('draftPrShort'),
      MERGED: taskT('mergedPrShort'),
      CLOSED: taskT('closedPr'),
    }
    prEl.className = `tasks-pr-badge ${stateMap[pr.state] ?? ''}`
    const checks = summarisePrChecks(pr.statusCheckRollup ?? [])
    prEl.textContent = checks.failed ? taskT('failedChecks', { count: checks.failed })
      : checks.pending ? taskT('pendingChecks', { count: checks.pending })
        : labelMap[pr.state] ?? taskT('openPrShort')
    const prSignals = [
      pr.baseRefName ? `base: ${pr.baseRefName}` : '',
      pr.mergeable === 'CONFLICTING' ? taskT('baseConflicts') : '',
      pr.reviewDecision === 'APPROVED' ? taskT('approved') : pr.reviewDecision === 'CHANGES_REQUESTED' ? taskT('changesRequested') : pr.reviewDecision === 'REVIEW_REQUIRED' ? taskT('reviewPending') : '',
      checks.failed ? taskT('failingChecks', { count: checks.failed }) : checks.pending ? taskT('checksPending', { count: checks.pending }) : checks.total ? taskT('checksPassed') : '',
    ].filter(Boolean)
    prEl.title = `${pr.title}${prSignals.length ? ` · ${prSignals.join(' · ')}` : ''}`
    if (checks.failed || pr.mergeable === 'CONFLICTING') prEl.classList.add('tasks-pr-checks-failed')
    prEl.addEventListener('click', e => { e.stopPropagation(); openUrl(pr.url).catch(() => {}) })
  }

  const backupEl = document.createElement('span')
  if (backup?.available && backup.different) {
    backupEl.className = 'tasks-backup-badge'
    backupEl.textContent = taskT('backupBadge')
    backupEl.title = `${backup.short ?? ''} ${backup.subject ?? ''}`.trim()
  }
  const rebaseEl = document.createElement('span')
  if (rebase?.active) {
    rebaseEl.className = 'tasks-rebase-badge'
    rebaseEl.textContent = rebase.total
      ? taskT('rebaseProgress', { current: rebase.current ?? 0, total: rebase.total })
      : taskT('pausedRebase')
    rebaseEl.title = taskT('resumeRebaseHint')
    rebaseEl.addEventListener('click', e => { e.stopPropagation(); selectRow(ctx, row); showRebasePaused(ctx, wt, rebase) })
  }
  const upstreamEl = document.createElement('span')
  if (upstream?.state === 'diverged') {
    upstreamEl.className = 'tasks-upstream-badge tasks-upstream-badge--diverged'
    upstreamEl.textContent = taskT('rewrittenHistory')
    upstreamEl.title = taskT('localRemoteCommits', { local: upstream.ahead, remote: upstream.behind })
  } else if (upstream?.state === 'behind') {
    upstreamEl.className = 'tasks-upstream-badge tasks-upstream-badge--behind'
    upstreamEl.textContent = taskT('remoteAhead', { count: upstream.behind })
  } else if (upstream?.state === 'unpublished') {
    upstreamEl.className = 'tasks-upstream-badge'
    upstreamEl.textContent = taskT('unpublished')
  }

  const runSync = async (mode: 'fetch' | 'merge' | 'rebase'): Promise<void> => {
    if (mode === 'rebase') {
      const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: worktreeBase }).catch(() => null)
      if (preflight?.operation) {
        selectRow(ctx, row); showSyncError(ctx, 'rebase', taskT('operationInProgress', { operation: preflight.operation }), wt)
        return
      }
      if (preflight?.protectedBase) {
        const ok = await askConfirm(taskT('protectedBranchQuestion', { branch: preflight.branch }), { title: taskT('protectedBranchTitle'), kind: 'warning' })
        if (!ok) return
      }
    }
    const needsCleanTree = mode !== 'fetch'
    let autostash = false
    if (needsCleanTree) {
      const hasChanges = (await taskGit.safeStatus(wt.path)).total > 0
      if (hasChanges) {
        const doStash = await askConfirm(
          taskT('dirtySyncQuestion', { branch: wt.branch ?? '' }),
          { title: taskT('syncWithStash'), kind: 'warning' },
        )
        if (!doStash) return
        autostash = true
      }
    }
    flashBadge(taskT('syncing'), '', 60000)
    try {
      const out = await invoke<string>('git_sync', { path: wt.path, base: worktreeBase, mode, autostash })
      recordOperation(ctx, wt, mode, 'success', `origin/${worktreeBase}${out.trim() ? ` · ${out.trim()}` : ''}`)
      flashBadge(out.trim() || taskT('upToDate'), 'tasks-badge--ok', 3000)
      void load(ctx)
    } catch (e) {
      recordOperation(ctx, wt, mode, 'error', String(e))
      flashBadge(taskT('syncError'), 'tasks-badge--error', 4000)
      selectRow(ctx, row)
      showSyncError(ctx, mode, String(e), wt)
    }
  }

  const openInJira = (): void => {
    if (!ctx.jiraCfg || !issue) return
    openUrl(browseUrl(ctx.jiraCfg.site, issue.key)).catch(() => {})
  }

  const changeJiraStatus = async (): Promise<void> => {
    if (!ctx.jiraCfg || !issue) return
    const transitions = await fetchTransitions(issue.key, ctx.jiraCfg)
    if (transitions.length === 0) return
    const r = menuBtn.getBoundingClientRect()
    showContextMenu(r.right - 4, r.bottom, transitions.map(t => ({
      label: t.name,
      onClick: async () => {
        await applyTransition(issue.key, t.id, ctx.jiraCfg!).catch(() => {})
        const updated = await fetchIssue(issue.key, ctx.jiraCfg!)
        ctx.issueMap.set(wt.path, updated)
        applyFilter(ctx)
      },
    })))
  }

  const copyBranch = (): void => { navigator.clipboard.writeText(wt.branch ?? '').catch(() => {}) }

  const pushBranch = async (): Promise<void> => {
    if (upstream?.state === 'behind') {
      const fetch = await askConfirm(
        taskT('remoteAheadQuestion', { count: upstream.behind }),
        { title: taskT('remoteAheadTitle'), kind: 'warning' },
      )
      if (fetch) runSync('fetch')
      return
    }
    if (upstream?.state === 'diverged') {
      const force = await askConfirm(
        taskT('divergedQuestion', { upstream: upstream.upstream ?? 'origin', local: upstream.ahead, remote: upstream.behind }),
        { title: taskT('rewrittenHistoryTitle'), kind: 'warning' },
      )
      if (!force) return
      flashBadge(taskT('pushingLease'), '', 60000)
      try {
        await invoke('git_push', { path: wt.path, forceWithLease: true })
        recordOperation(ctx, wt, 'push --force-with-lease', 'success', upstream.upstream ?? 'origin')
        flashBadge(taskT('leaseOk'), 'tasks-badge--ok', 3500)
        void load(ctx)
      } catch (e) {
        recordOperation(ctx, wt, 'push --force-with-lease', 'error', String(e))
        flashBadge(taskT('pushRejected'), 'tasks-badge--error', 4000)
        selectRow(ctx, row); showSyncError(ctx, 'push --force-with-lease', String(e), wt)
      }
      return
    }
    flashBadge(taskT('pushing'), '', 60000)
    try {
      await invoke('git_push', { path: wt.path })
      recordOperation(ctx, wt, 'push', 'success', upstream?.upstream ?? 'origin')
      flashBadge(taskT('pushOk'), 'tasks-badge--ok', 3000)
      void load(ctx)
    } catch (e) {
      const message = String(e)
      if (/non-fast-forward|rejected|fetch first/i.test(message)) {
        const force = await askConfirm(
          taskT('safePushQuestion'),
          { title: taskT('safePushTitle'), kind: 'warning' },
        )
        if (force) {
          try {
            await invoke('git_push', { path: wt.path, forceWithLease: true })
            recordOperation(ctx, wt, 'push --force-with-lease', 'success', upstream?.upstream ?? 'origin')
            flashBadge(taskT('leaseOk'), 'tasks-badge--ok', 3500)
            void load(ctx)
            return
          } catch (forceError) {
            recordOperation(ctx, wt, 'push --force-with-lease', 'error', String(forceError))
            flashBadge(taskT('pushRejected'), 'tasks-badge--error', 4000)
            selectRow(ctx, row)
            showSyncError(ctx, 'push --force-with-lease', String(forceError), wt)
            return
          }
        }
      }
      recordOperation(ctx, wt, 'push', 'error', message)
      flashBadge(taskT('pushError'), 'tasks-badge--error', 4000)
      selectRow(ctx, row)
      showSyncError(ctx, 'push', message, wt)
    }
  }

  const restoreBackup = async (): Promise<void> => {
    if (!backup?.available || !backup.different) return
    const ok = await askConfirm(
      taskT('restoreQuestion', { short: backup.short ?? '', subject: backup.subject ?? '' }),
      { title: taskT('undoRewrite'), kind: 'warning' },
    )
    if (!ok) return
    try {
      await invoke('git_restore_backup', { path: wt.path })
      recordOperation(ctx, wt, taskT('restoringBackup'), 'success', backup.short ?? '')
      flashBadge(taskT('restoredHistory'), 'tasks-badge--ok', 3500)
      await load(ctx)
      void showChanges(ctx, wt)
    } catch (e) {
      recordOperation(ctx, wt, taskT('restoringBackup'), 'error', String(e))
      selectRow(ctx, row)
      showSyncError(ctx, taskT('restoringBackup'), String(e), wt)
    }
  }

  const createPR = async (): Promise<void> => {
    flashBadge(taskT('creatingPr'), '', 60000)
    try {
      const result = await invoke<string>('git_create_pr', { path: wt.path, base: worktreeBase })
      flashBadge(taskT('prCreated'), 'tasks-badge--ok', 3000)
      if (result.startsWith('http')) openUrl(result).catch(() => {})
      void load(ctx)
    } catch (e) {
      flashBadge(taskT('prCreateError'), 'tasks-badge--error', 4000)
      selectRow(ctx, row)
      showSyncError(ctx, 'PR', String(e), wt)
    }
  }

  const renameTask = async (): Promise<void> => {
    const current = wt.branch ?? ''

    const newName = window.prompt(taskT('renamePrompt', { current }), current)
    if (!newName || newName === current) return
    try {
      await invoke('git_branch_rename', { path: wt.path, newName })
      void load(ctx)
    } catch (e) {
      await askConfirm(String(e), { title: taskT('renameError'), kind: 'error' })
    }
  }

  const ahead = ab?.ahead ?? 0
  const hasPr = !!pr && (pr.state === 'OPEN' || pr.state === 'DRAFT')

  const menuItems = () => taskRowActions({
    worktree: wt, row, isMain, baseBranch: worktreeBase, ahead, hasPr, issue: !!issue, jiraConfigured: !!ctx.jiraCfg, pr, backup, rebase,
    selectRow: r => selectRow(ctx, r), showRebasePaused: (worktree, status) => showRebasePaused(ctx, worktree, status),
    showChanges: worktree => void showChanges(ctx, worktree), showHistory: worktree => void showCommitLog(ctx, worktree), showGraph: worktree => void showCommitGraph(ctx, worktree),
    showInteractiveRebase: worktree => void showInteractiveRebase(ctx, worktree), showTerminal: worktree => void showWorktreeTerminal(ctx, worktree), showPrDetails: (worktree, status) => showPrDetails(ctx, worktree, status), showReset: worktree => showResetView(ctx, worktree),
    showBackups: worktree => void showBackupHistory(ctx, worktree), showOperations: worktree => showOperationHistory(ctx, worktree),
    isolateDocker: wt => { void ctx.dockerView.isolate(wt) },
    prepareDevcontainer: wt => { if (ctx.repoPath) void prepareTaskDevcontainer(ctx, wt).then(ok => { if (!ok) showDetail(ctx, note(taskT('noDevcontainer'), 'db-detail-hint')) }) },
    runSync, copyBranch, openJira: openInJira,
    changeJiraStatus, push: pushBranch, createPr: createPR, restoreBackup, rename: renameTask,
    deleteTask: () => void deleteWorktree(ctx, wt), setBase: branch => { ctx.baseBranch = branch; ctx.panelStore.setBase(branch) }, reload: () => void load(ctx),
  })

  const menuBtn = iconBtn('more', taskT('actions'), () => {
    // iconBtn stops propagation, so opening the row menu must explicitly
    // count as user interaction. Otherwise a slow startup enrichment can
    // still "restore" the saved task after an action (for example Backups)
    // has navigated elsewhere and replace that newly opened detail.
    selectWorktree(ctx, row, wt)
    const r = menuBtn.getBoundingClientRect()
    showContextMenu(r.right - 4, r.bottom, menuItems())
  })
  menuBtn.dataset.testid = 'tasks-actions'
  const actions = document.createElement('div')
  actions.className = 'tasks-actions'
  actions.appendChild(menuBtn)

  row.addEventListener('click', async () => {
    const version = selectWorktree(ctx, row, wt)
    if (rebase?.active) { showRebasePaused(ctx, wt, rebase); return }
    // Devcontainer tasks show their URLs (cheap read); anything else shows the diff.
    const hasDevcontainerUrls = !isMain && await ctx.dockerView.showDevcontainerUrls(wt, ctx.panelStore.devcontainerDir() ?? undefined, () => isCurrentSelection(ctx, version, wt))
    if (!isCurrentSelection(ctx, version, wt)) return
    if (hasDevcontainerUrls) return
    void showChanges(ctx, wt)
  })
  row.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault(); row.click()
  })
  row.addEventListener('contextmenu', e => {
    e.preventDefault()
    selectWorktree(ctx, row, wt)
    showContextMenu(e.clientX, e.clientY, menuItems())
  })
  // Badges wrap onto their own line under the name/path so the branch name
  // always predominates and never gets crowded out. Empty ones are hidden by CSS.
  const badges = document.createElement('div')
  badges.className = 'tasks-row-badges'
  badges.append(abEl, prEl, rebaseEl, upstreamEl, backupEl, recipeEl, badge)
  left.appendChild(badges)

  // Row: status dot · name/path/badges column · always-visible actions menu.
  row.append(runDot, left, actions)
  return row
}

// Single create form for the whole panel: a repo selector (only when several
// repos are open) + task name. Replaces the per-project forms.
