import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { open as pickFolder, confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import { taskBranch, taskPath, type Worktree } from '../../core/git/worktree'
import { parseContainers, isRunning } from '../../core/docker/containers'
import { showContextMenu, type MenuItem } from '../../ui/contextMenu'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'
import { extractIssueKey, statusCategoryClass, parseAheadBehind } from '../../core/git/taskJira'
import { diffFileNames, changedPaths, matchingPaths, buildSelectedPatch } from '../../core/git/commitWorkflow'
import { parseConflictFiles } from '../../core/git/conflictWorkflow'
import { mapWithConcurrency, previewRebase, type RebaseAction, type RebasePlanItem } from '../../core/git/rebaseWorkflow'
import {
  loadJiraConfig, fetchIssue, fetchTransitions, applyTransition, browseUrl,
  type JiraConfig, type TaskIssue,
} from './taskJiraClient'
import { buildOperationHistoryView } from './OperationHistoryView'
import type { BackupStatus, CommitEntry, PrStatus, RebaseStatus, RewritePreflight, UpstreamStatus } from './gitTypes'
import { buildPrStatusView } from './PrStatusView'
import { getTaskLocale, setTaskLocale, taskT, type TaskLocale } from './i18n'
import { buildBackupHistoryView } from './BackupHistoryView'
import { buildConflictResolverView } from './ConflictResolverView'
import { buildChangesFileView } from './ChangesFileView'
import { buildRebasePlanPreview } from './RebasePlanView'
import { buildCommitFileList, escapeCodeHtml as escHtml, fileStateMap, renderPatchHtml } from './TaskCodeView'
import { commitFilesRaw, recommendationMap, taskGit } from './taskGitClient'
import { TaskPanelStore } from './TaskPanelStore'
import { createTaskDockerView, type IsolateResult } from './TaskDockerView'

export function createTasksPanel(panelId = 'default'): { element: HTMLElement } {
  const panelStore = new TaskPanelStore(panelId)
  let worktrees: Worktree[] = []
  let repoPath = panelStore.repository()
  let detailCleanup: () => void = () => {}
  let selectedRow: HTMLElement | null = null
  let filterText = ''
  let lastStatuses = new Map<string, number>()
  let lastRunningPaths = new Set<string>()
  let baseBranch = panelStore.base()
  let jiraCfg: JiraConfig | null = null
  const issueMap = new Map<string, TaskIssue | null>()
  const aheadBehindMap = new Map<string, { ahead: number; behind: number }>()
  const prStatusMap = new Map<string, PrStatus | null>()
  const backupStatusMap = new Map<string, BackupStatus>()
  const rebaseStatusMap = new Map<string, RebaseStatus>()
  const upstreamStatusMap = new Map<string, UpstreamStatus>()
  let fetchedAt = 0
  let diffRefreshInterval: ReturnType<typeof setInterval> | null = null

  const recordOperation = (wt: Worktree, operation: string, status: 'success' | 'error', detail: string): void => {
    panelStore.recordOperation(repoPath, wt.branch ?? '(detached)', operation, status, detail)
  }

  const selectRow = (row: HTMLElement): void => {
    selectedRow?.classList.remove('tasks-row--selected')
    selectedRow = row
    row.classList.add('tasks-row--selected')
  }

  const stopDiffRefresh = (): void => {
    if (diffRefreshInterval !== null) { clearInterval(diffRefreshInterval); diffRefreshInterval = null }
  }

  const root = document.createElement('div')
  root.className = 'tasks-panel'
  root.dataset.testid = 'tasks-panel'
  root.dataset.panelId = panelId

  // ---- header ----
  const header = document.createElement('div')
  header.className = 'tasks-header'
  const titleEl = document.createElement('span')
  titleEl.className = 'tasks-title'
  titleEl.textContent = taskT('tasks')
  const repoBtn = document.createElement('button')
  repoBtn.className = 'tasks-repo-btn'
  repoBtn.dataset.testid = 'tasks-select-repository'
  repoBtn.title = taskT('selectRepo')
  const updateRepoBtn = (): void => {
    const name = repoPath ? repoPath.replace(/\/$/, '').split('/').pop()! : taskT('selectRepoShort')
    repoBtn.replaceChildren()
    const iconSlot = document.createElement('span')
    iconSlot.innerHTML = icon('folder')
    const label = document.createElement('span')
    label.textContent = name
    repoBtn.append(iconSlot, label)
  }
  updateRepoBtn()
  repoBtn.addEventListener('click', async () => {
    const picked = await pickFolder({ directory: true, defaultPath: repoPath || undefined }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked
    panelStore.setRepository(repoPath)
    updateRepoBtn()
    load()
  })
  const baseSelect = document.createElement('select')
  baseSelect.className = 'tasks-base-select'
  baseSelect.title = taskT('baseBranch')
  baseSelect.addEventListener('change', () => {
    baseBranch = baseSelect.value
    panelStore.setBase(baseBranch)
    load()
  })
  const fetchAgeEl = document.createElement('span')
  fetchAgeEl.className = 'tasks-fetch-age'
  const localeSelect = document.createElement('select')
  localeSelect.className = 'tasks-locale-select'
  localeSelect.title = taskT('language')
  ;(['es', 'en'] as TaskLocale[]).forEach(locale => localeSelect.appendChild(Object.assign(document.createElement('option'), {
    value: locale, textContent: locale === 'es' ? taskT('spanish') : taskT('english'), selected: locale === getTaskLocale(),
  })))
  localeSelect.addEventListener('change', () => { setTaskLocale(localeSelect.value as TaskLocale); location.reload() })
  const refreshBtn = iconBtn('refresh', taskT('reload'), () => load())
  header.append(titleEl, repoBtn, baseSelect, localeSelect, fetchAgeEl, refreshBtn)

  // ---- layout ----
  const body = document.createElement('div')
  body.className = 'tasks-body'

  const sidebar = document.createElement('div')
  sidebar.className = 'tasks-sidebar'

  const filterInput = Object.assign(document.createElement('input'), {
    className: 'tasks-filter-input',
    type: 'search',
    placeholder: taskT('filter'),
  })
  filterInput.addEventListener('input', () => { filterText = filterInput.value; applyFilter() })

  const listWrap = document.createElement('div')
  listWrap.className = 'tasks-list-wrap'

  sidebar.append(filterInput, listWrap)

  const detailPane = document.createElement('div')
  detailPane.className = 'tasks-detail'
  body.append(sidebar, detailPane)
  root.append(header, body)

  const note = (text: string, cls = 'tasks-note'): HTMLElement =>
    Object.assign(document.createElement('div'), { className: cls, textContent: text })

  const showDetail = (...nodes: HTMLElement[]): void => { detailPane.replaceChildren(...nodes) }
  const buildSubHead = (title: string, goBack: () => void, ...extra: HTMLElement[]): HTMLElement => {
    const head = document.createElement('div')
    head.className = 'tasks-sub-head'
    head.append(
      iconBtn('arrow-left', taskT('back'), goBack),
      Object.assign(document.createElement('span'), { className: 'tasks-sub-title', textContent: title }),
      ...extra,
    )
    return head
  }
  const dockerView = createTaskDockerView({
    showDetail,
    resetDetail: () => { stopDiffRefresh(); detailCleanup(); detailCleanup = () => {} },
    setCleanup: cleanup => { detailCleanup = cleanup },
  })

  showDetail(note(taskT('selectTask'), 'db-detail-hint'))

  // ---- list ----
  function renderList(statuses: Map<string, number>, runningPaths: Set<string>): void {
    lastStatuses = statuses
    lastRunningPaths = runningPaths
    applyFilter()
  }

  function applyFilter(): void {
    const lf = filterText.toLowerCase()
    const filtered = filterText
      ? worktrees.filter(wt => (wt.branch ?? '').toLowerCase().includes(lf) || wt.path.toLowerCase().includes(lf))
      : worktrees

    listWrap.replaceChildren()
    if (filtered.length === 0) {
      listWrap.append(
        note(worktrees.length === 0 ? taskT('noWorktrees') : taskT('noResults')),
        buildCreateForm(),
      )
      return
    }
    const list = document.createElement('div')
    list.className = 'tasks-list'
    filtered.forEach((wt, i) => {
      const isMain = i === 0 && !filterText
      list.appendChild(buildRow(wt, isMain, lastStatuses.get(wt.path) ?? 0, lastRunningPaths.has(wt.path)))
    })
    listWrap.append(list, buildCreateForm())
  }

  function buildRow(wt: Worktree, isMain: boolean, changes: number, hasRunning: boolean): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tasks-row'
    row.dataset.testid = 'tasks-row'
    row.dataset.branch = wt.branch ?? ''
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.setAttribute('aria-label', `${taskT('tasks')}: ${wt.branch ?? ''}, ${taskT('changes', { count: changes })}`)

    const runDot = document.createElement('span')
    runDot.className = `tasks-run-dot ${hasRunning ? 'docker-up' : ''}`
    runDot.title = hasRunning ? taskT('containersRunning') : taskT('noContainers')

    const issue = issueMap.get(wt.path) ?? null
    const ab = aheadBehindMap.get(wt.path)
    const pr = prStatusMap.get(wt.path) ?? null
    const backup = backupStatusMap.get(wt.path)
    const rebase = rebaseStatusMap.get(wt.path)
    const upstream = upstreamStatusMap.get(wt.path)

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
      abEl.title = taskT('aheadBehindTitle', { ahead: ab.ahead, behind: ab.behind, branch: baseBranch })
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
      const checks = pr.statusCheckRollup ?? []
      const failedChecks = checks.filter(check => /FAIL|ERROR|CANCEL|TIMED_OUT/i.test(check.conclusion ?? check.state ?? ''))
      const pendingChecks = checks.filter(check => /PENDING|QUEUED|IN_PROGRESS|EXPECTED/i.test(check.status ?? check.state ?? ''))
      prEl.textContent = failedChecks.length ? taskT('failedChecks', { count: failedChecks.length })
        : pendingChecks.length ? taskT('pendingChecks', { count: pendingChecks.length })
          : labelMap[pr.state] ?? taskT('openPrShort')
      const prSignals = [
        pr.baseRefName ? `base: ${pr.baseRefName}` : '',
        pr.mergeable === 'CONFLICTING' ? taskT('baseConflicts') : '',
        pr.reviewDecision === 'APPROVED' ? taskT('approved') : pr.reviewDecision === 'CHANGES_REQUESTED' ? taskT('changesRequested') : pr.reviewDecision === 'REVIEW_REQUIRED' ? taskT('reviewPending') : '',
        failedChecks.length ? taskT('failingChecks', { count: failedChecks.length }) : pendingChecks.length ? taskT('checksPending', { count: pendingChecks.length }) : checks.length ? taskT('checksPassed') : '',
      ].filter(Boolean)
      prEl.title = `${pr.title}${prSignals.length ? ` · ${prSignals.join(' · ')}` : ''}`
      if (failedChecks.length || pr.mergeable === 'CONFLICTING') prEl.classList.add('tasks-pr-checks-failed')
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
      rebaseEl.addEventListener('click', e => { e.stopPropagation(); selectRow(row); showRebasePaused(wt, rebase) })
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
        const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: baseBranch }).catch(() => null)
        if (preflight?.operation) {
          selectRow(row); showSyncError('rebase', taskT('operationInProgress', { operation: preflight.operation }), wt)
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
        const out = await invoke<string>('git_sync', { path: wt.path, base: baseBranch, mode, autostash })
        recordOperation(wt, mode, 'success', `origin/${baseBranch}${out.trim() ? ` · ${out.trim()}` : ''}`)
        flashBadge(out.trim() || taskT('upToDate'), 'tasks-badge--ok', 3000)
        load()
      } catch (e) {
        recordOperation(wt, mode, 'error', String(e))
        flashBadge(taskT('syncError'), 'tasks-badge--error', 4000)
        selectRow(row)
        showSyncError(mode, String(e), wt)
      }
    }

    const openInJira = (): void => {
      if (!jiraCfg || !issue) return
      openUrl(browseUrl(jiraCfg.site, issue.key)).catch(() => {})
    }

    const changeJiraStatus = async (): Promise<void> => {
      if (!jiraCfg || !issue) return
      const transitions = await fetchTransitions(issue.key, jiraCfg)
      if (transitions.length === 0) return
      const r = menuBtn.getBoundingClientRect()
      showContextMenu(r.right - 4, r.bottom, transitions.map(t => ({
        label: t.name,
        onClick: async () => {
          await applyTransition(issue.key, t.id, jiraCfg!).catch(() => {})
          const updated = await fetchIssue(issue.key, jiraCfg!)
          issueMap.set(wt.path, updated)
          applyFilter()
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
          recordOperation(wt, 'push --force-with-lease', 'success', upstream.upstream ?? 'origin')
          flashBadge(taskT('leaseOk'), 'tasks-badge--ok', 3500)
          load()
        } catch (e) {
          recordOperation(wt, 'push --force-with-lease', 'error', String(e))
          flashBadge(taskT('pushRejected'), 'tasks-badge--error', 4000)
          selectRow(row); showSyncError('push --force-with-lease', String(e), wt)
        }
        return
      }
      flashBadge(taskT('pushing'), '', 60000)
      try {
        await invoke('git_push', { path: wt.path })
        recordOperation(wt, 'push', 'success', upstream?.upstream ?? 'origin')
        flashBadge(taskT('pushOk'), 'tasks-badge--ok', 3000)
        load()
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
              recordOperation(wt, 'push --force-with-lease', 'success', upstream?.upstream ?? 'origin')
              flashBadge(taskT('leaseOk'), 'tasks-badge--ok', 3500)
              load()
              return
            } catch (forceError) {
              recordOperation(wt, 'push --force-with-lease', 'error', String(forceError))
              flashBadge(taskT('pushRejected'), 'tasks-badge--error', 4000)
              selectRow(row)
              showSyncError('push --force-with-lease', String(forceError), wt)
              return
            }
          }
        }
        recordOperation(wt, 'push', 'error', message)
        flashBadge(taskT('pushError'), 'tasks-badge--error', 4000)
        selectRow(row)
        showSyncError('push', message, wt)
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
        recordOperation(wt, 'restaurar respaldo', 'success', backup.short ?? '')
        flashBadge(taskT('restoredHistory'), 'tasks-badge--ok', 3500)
        await load()
        showChanges(wt)
      } catch (e) {
        recordOperation(wt, 'restaurar respaldo', 'error', String(e))
        selectRow(row)
        showSyncError(taskT('restoringBackup'), String(e), wt)
      }
    }

    const createPR = async (): Promise<void> => {
      flashBadge(taskT('creatingPr'), '', 60000)
      try {
        const result = await invoke<string>('git_create_pr', { path: wt.path, base: baseBranch })
        flashBadge(taskT('prCreated'), 'tasks-badge--ok', 3000)
        if (result.startsWith('http')) openUrl(result).catch(() => {})
        load()
      } catch (e) {
        flashBadge(taskT('prCreateError'), 'tasks-badge--error', 4000)
        selectRow(row)
        showSyncError('PR', String(e), wt)
      }
    }

    const renameTask = async (): Promise<void> => {
      const current = wt.branch ?? ''

      const newName = window.prompt(taskT('renamePrompt', { current }), current)
      if (!newName || newName === current) return
      try {
        await invoke('git_branch_rename', { path: wt.path, newName })
        load()
      } catch (e) {
        await askConfirm(String(e), { title: taskT('renameError'), kind: 'error' })
      }
    }

    const ahead = ab?.ahead ?? 0
    const hasPr = !!pr && (pr.state === 'OPEN' || pr.state === 'DRAFT')

    const menuItems = () => {
      const items: MenuItem[] = [
        ...(rebase?.active ? [{ label: `Continuar rebase${rebase.total ? ` · ${rebase.current ?? 0}/${rebase.total}` : ''}`, onClick: () => { selectRow(row); showRebasePaused(wt, rebase) } }] : []),
        { label: taskT('viewChanges'), onClick: () => { selectRow(row); showChanges(wt) } },
        { label: taskT('viewHistory'), onClick: () => { selectRow(row); showCommitLog(wt) } },
        { label: taskT('viewGraph'), onClick: () => { selectRow(row); showCommitGraph(wt) } },
        { label: taskT('interactiveRebase'), onClick: () => { selectRow(row); showInteractiveRebase(wt) } },
        { label: taskT('openEditor'), onClick: () => { invoke('open_in_editor', { path: wt.path }).catch(console.error) } },
        { label: taskT('terminal'), onClick: () => { selectRow(row); showWorktreeTerminal(wt) } },
        { label: taskT('copyBranch'), onClick: copyBranch },
      ]
      if (issue && jiraCfg) {
        items.push(
          { label: taskT('openJira'), onClick: openInJira },
          { label: taskT('changeStatus'), onClick: () => { changeJiraStatus() } },
        )
      }
      if (pr?.baseRefName && pr.baseRefName !== baseBranch) {
        items.push({
          label: `Usar base de la PR → ${pr.baseRefName}`,
          onClick: () => {
            baseBranch = pr.baseRefName!
            panelStore.setBase(baseBranch)
            load()
          },
        })
      }
      if (!isMain) {
        items.push(
          { label: 'Docker', onClick: () => { selectRow(row); void dockerView.isolate(wt) } },
          { label: taskT('fetch'), onClick: () => runSync('fetch') },
          { label: `Merge origin/${baseBranch}`, onClick: () => runSync('merge') },
          { label: `Rebase sobre origin/${baseBranch}`, onClick: () => runSync('rebase') },
          { label: taskT('push'), onClick: pushBranch },
        )
        if (ahead > 0 && !hasPr) {
          items.push({ label: taskT('createPrFor', { base: baseBranch }), onClick: createPR })
        }
        if (pr?.url) {
          items.push({ label: taskT('viewPr'), onClick: () => openUrl(pr.url).catch(() => {}) })
          items.push({ label: taskT('prChecks'), onClick: () => { selectRow(row); showPrDetails(wt, pr) } })
        }
        items.push(
          { label: `Resetear a origin/${baseBranch}…`, onClick: () => { selectRow(row); showResetView(wt) } },
          { label: taskT('backups'), testId: 'tasks-backups-action', onClick: () => { selectRow(row); showBackupHistory(wt) } },
          { label: taskT('operations'), onClick: () => { selectRow(row); showOperationHistory(wt) } },
          ...(backup?.available && backup.different ? [{ label: `Deshacer reescritura → ${backup.short ?? 'respaldo'}`, onClick: restoreBackup }] : []),
          { label: taskT('rename'), onClick: renameTask },
          { label: taskT('deleteTask'), onClick: () => deleteWorktree(wt) },
        )
      }
      return items
    }

    const menuBtn = iconBtn('more', taskT('actions'), () => {
      const r = menuBtn.getBoundingClientRect()
      showContextMenu(r.right - 4, r.bottom, menuItems())
    })
    menuBtn.dataset.testid = 'tasks-actions'
    const actions = document.createElement('div')
    actions.className = 'tasks-actions'
    actions.appendChild(menuBtn)

    row.addEventListener('click', () => {
      selectRow(row)
      panelStore.setSelected(wt.path)
      if (rebase?.active) showRebasePaused(wt, rebase)
      else showChanges(wt)
    })
    row.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault(); row.click()
    })
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      selectRow(row)
      showContextMenu(e.clientX, e.clientY, menuItems())
    })
    row.append(runDot, left, abEl, prEl, rebaseEl, upstreamEl, backupEl, badge, actions)
    return row
  }

  function buildCreateForm(): HTMLElement {
    const form = document.createElement('div')
    form.className = 'tasks-create'
    const input = Object.assign(document.createElement('input'), { className: 'tasks-name-input', type: 'text', placeholder: taskT('newTask') })
    const btn = iconBtn('plus', taskT('createTask'), () => createTask(input.value.trim()))
    input.addEventListener('keydown', e => { if (e.key === 'Enter') createTask(input.value.trim()) })
    form.append(input, btn)
    return form
  }

  // ---- detail: changes (GitHub-style diff + commit bar) ----
  async function showChanges(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loadingChanges'), 'db-detail-loading'))
    try {
      const [raw, statusRaw, rebaseStatus] = await Promise.all([
        invoke<string>('git_diff', { path: wt.path }),
        taskGit.safeStatus(wt.path),
        invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false })),
      ])
      const rebaseActive = rebaseStatus.active
      showDetail(buildDiffView(raw, wt, { statusRaw: statusRaw.raw, rebaseActive }))
      // Auto-refresh: re-fetch diff every 5 s and update if content changed
      let lastSnapshot = `${statusRaw.raw}\0${raw}`
      diffRefreshInterval = setInterval(async () => {
        const [newRaw, newStatus] = await Promise.all([
          invoke<string>('git_diff', { path: wt.path }).catch(() => null),
          taskGit.safeStatus(wt.path),
        ])
        const snapshot = `${newStatus.raw}\0${newRaw ?? ''}`
        if (newRaw !== null && snapshot !== lastSnapshot) {
          lastSnapshot = snapshot
          showDetail(buildDiffView(newRaw, wt, { statusRaw: newStatus.raw, rebaseActive }))
        }
      }, 5000)
      detailCleanup = () => stopDiffRefresh()
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function buildDiffView(raw: string, wt: Worktree, opts: { initMessage?: string; initAmend?: boolean; statusRaw?: string; rebaseActive?: boolean } = {}): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'tasks-diff'

    // Track which files are checked for partial staging
    const checkedFiles = new Set<string>()
    const selectedHunks = new Map<string, Set<number>>()
    const fileStates = fileStateMap(opts.statusRaw ?? '')

    // ---- commit bar ----
    const commitBar = document.createElement('div')
    commitBar.className = 'tasks-commit-bar'

    const msgInput = Object.assign(document.createElement('input'), {
      className: 'tasks-commit-msg',
      type: 'text',
      placeholder: taskT('commitMessage'),
      value: opts.initMessage ?? '',
    })
    msgInput.dataset.testid = 'tasks-commit-message'

    const amendToggle = Object.assign(document.createElement('button'), {
      className: 'tasks-amend-btn',
      title: taskT('amendHint'),
      textContent: taskT('amend'),
    })
    let doAmend = opts.initAmend ?? false
    amendToggle.classList.toggle('tasks-amend-btn--active', doAmend)
    if (doAmend) msgInput.placeholder = taskT('keepMessage')
    amendToggle.addEventListener('click', () => {
      doAmend = !doAmend
      amendToggle.classList.toggle('tasks-amend-btn--active', doAmend)
      msgInput.placeholder = doAmend ? taskT('keepMessage') : taskT('commitMessage')
      commitBtn.textContent = doAmend ? taskT('amendCommit') : taskT('commit')
    })

    const commitBtn = Object.assign(document.createElement('button'), {
      className: 'tasks-commit-btn',
      textContent: taskT('commit'),
    })
    commitBtn.dataset.testid = 'tasks-commit'
    const fixupBtn = Object.assign(document.createElement('button'), {
      className: 'tasks-amend-btn',
      title: taskT('addToPreviousHint'),
      textContent: taskT('fixupInto'),
      disabled: !raw.trim(),
    })
    fixupBtn.addEventListener('click', () => {
      const selectedPatch = buildSelectedPatch(raw, checkedFiles, selectedHunks)
      showFixupPicker(wt, undefined, selectedPatch || raw, selectedPatch || undefined)
    })

    const showCommitStatus = (text: string, isError = false): void => {
      const el = Object.assign(document.createElement('span'), {
        className: isError ? 'tasks-commit-err' : 'tasks-commit-ok',
        textContent: text,
      })
      commitBar.appendChild(el)
      setTimeout(() => el.remove(), isError ? 5000 : 3000)
    }

    commitBtn.addEventListener('click', async () => {
      const msg = msgInput.value.trim()
      if (!doAmend && !msg) { msgInput.focus(); return }
      commitBtn.disabled = true
      amendToggle.disabled = true
      fixupBtn.disabled = true
      commitBtn.textContent = '…'
      try {
        const selectedPatch = buildSelectedPatch(raw, checkedFiles, selectedHunks)
        await invoke('git_commit', { path: wt.path, message: msg, amend: doAmend || undefined, patch: selectedPatch || undefined })
        recordOperation(wt, doAmend ? 'commit --amend' : 'commit', 'success', msg || taskT('keptMessage'))
        const wasAmend = doAmend
        msgInput.value = ''
        doAmend = false
        amendToggle.classList.remove('tasks-amend-btn--active')
        commitBtn.textContent = taskT('commit')
        const [newRaw, newStatus] = await Promise.all([
          invoke<string>('git_diff', { path: wt.path }),
          taskGit.safeStatus(wt.path),
        ])
        showDetail(buildDiffView(newRaw, wt, { statusRaw: newStatus.raw, rebaseActive: opts.rebaseActive }))
        showCommitStatus(wasAmend ? taskT('commitAmended') : taskT('commitCreated'))
        // Update sidebar badge and ahead/behind
        lastStatuses.set(wt.path, (await taskGit.safeStatus(wt.path)).total)
        const abRaw = await invoke<string>('git_ahead_behind', { path: wt.path, base: baseBranch }).catch(() => '')
        aheadBehindMap.set(wt.path, parseAheadBehind(abRaw))
        applyFilter()
      } catch (e) {
        recordOperation(wt, doAmend ? 'commit --amend' : 'commit', 'error', String(e))
        commitBtn.textContent = doAmend ? taskT('amendCommit') : taskT('commit')
        commitBtn.disabled = false
        amendToggle.disabled = false
        fixupBtn.disabled = false
        showCommitStatus(String(e).slice(0, 120), true)
      }
    })

    commitBar.append(msgInput, amendToggle, fixupBtn, commitBtn)

    if (opts.rebaseActive) wrap.appendChild(note(
      taskT('pausedCommitHint'),
      'tasks-rebase-hint tasks-conflict-warning',
    ))

    if (!raw.trim()) {
      wrap.append(commitBar, note(taskT('noChanges'), 'db-detail-hint'))
      return wrap
    }

    const chunks = raw.split(/(?=^diff --git )/m).filter(Boolean)

    for (const chunk of chunks) {
      const firstLine = chunk.split('\n')[0] ?? ''
      const fileName = firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
      wrap.appendChild(buildChangesFileView({
        chunk, state: fileStates.get(fileName), checkedFiles, selectedHunks, renderPatch: renderPatchHtml,
      }))
    }

    wrap.appendChild(commitBar)
    return wrap
  }

  function buildIncomingChanges(raw: string, selectedFiles?: string[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'tasks-fixup-incoming'
    const selected = selectedFiles ? new Set(selectedFiles) : null
    const chunks = raw.split(/(?=^diff --git )/m).filter(Boolean).filter(chunk => {
      if (!selected) return true
      const firstLine = chunk.split('\n')[0] ?? ''
      const fileName = firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
      return selected.has(fileName)
    })
    section.appendChild(Object.assign(document.createElement('h3'), {
      className: 'tasks-fixup-incoming-title',
      textContent: taskT('incomingChanges', { count: chunks.length }),
    }))

    for (const chunk of chunks) {
      const firstLine = chunk.split('\n')[0] ?? ''
      const fileName = firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
      const lines = chunk.split('\n')
      const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length
      const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length
      const details = document.createElement('details')
      details.className = 'tasks-diff-file'
      details.open = chunks.length === 1
      const summary = document.createElement('summary')
      summary.className = 'tasks-diff-summary'
      const stats = document.createElement('span')
      stats.className = 'tasks-diff-stats'
      if (additions) stats.innerHTML += `<span class="tasks-diff-add">+${additions}</span>`
      if (deletions) stats.innerHTML += `<span class="tasks-diff-del">-${deletions}</span>`
      summary.append(
        Object.assign(document.createElement('span'), { className: 'tasks-diff-name', textContent: fileName }),
        stats,
      )
      const patch = document.createElement('pre')
      patch.className = 'tasks-diff-body'
      patch.innerHTML = renderPatchHtml(chunk)
      details.append(summary, patch)
      section.appendChild(details)
    }

    if (chunks.length === 0) {
      section.appendChild(note(taskT('noSelectedTextDiff'), 'db-detail-hint'))
    }
    return section
  }

  // ---- detail: choose an existing commit for fixup ----
  async function showFixupPicker(wt: Worktree, files: string[] | undefined, incomingDiff: string, selectedPatch?: string): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loadingCommits'), 'db-detail-loading'))
    try {
      const entries = await taskGit.rebaseLog(wt.path, baseBranch)
      if (entries.length === 0) {
        showDetail(note(taskT('noOwnCommits', { base: baseBranch }), 'db-detail-hint'))
        return
      }

      const incomingFiles = new Set(files ?? diffFileNames(incomingDiff))
      const [recommendations, blameRecommendations] = await Promise.all([
        taskGit.recommendations(wt.path, baseBranch, [...incomingFiles]).catch(() => []),
        taskGit.blameRecommendations(wt.path, baseBranch, incomingDiff).catch(() => []),
      ])
      const historyScores = recommendationMap(recommendations)
      const blameScores = recommendationMap(blameRecommendations)
      const enriched = await Promise.all(entries.map(async (entry, originalIndex) => {
        const commitFiles = await taskGit.files(wt.path, entry.hash).catch(() => [])
        const filesRaw = commitFilesRaw(commitFiles)
        const overlap = matchingPaths(incomingFiles, changedPaths(filesRaw))
        const history = historyScores.get(entry.hash) ?? { score: 0, files: [] }
        const blame = blameScores.get(entry.hash) ?? { score: 0, files: [] }
        return { entry, commitFiles, overlap, history, blame, originalIndex }
      }))
      enriched.sort((a, b) =>
        (b.overlap.length * 10000 + b.blame.score * 100 + b.history.score)
        - (a.overlap.length * 10000 + a.blame.score * 100 + a.history.score)
        || a.originalIndex - b.originalIndex)

      const wrap = document.createElement('div')
      wrap.className = 'tasks-fixup-wrap'
      wrap.append(buildSubHead(taskT('addChangesTitle'), () => showChanges(wt)))
      wrap.appendChild(Object.assign(document.createElement('p'), {
        className: 'tasks-rebase-hint',
        textContent: selectedPatch
          ? taskT('incomingSelection', { count: incomingFiles.size })
          : files?.length
            ? taskT('incomingFiles', { count: files.length })
            : taskT('incomingAll'),
      }))
      wrap.appendChild(buildIncomingChanges(incomingDiff, files))

      const list = document.createElement('div')
      list.className = 'tasks-fixup-list'
      for (const { entry, commitFiles, overlap, history, blame } of enriched) {
        const item = document.createElement('div')
        item.className = `tasks-fixup-item${overlap.length || history.score || blame.score ? ' tasks-fixup-item--match' : ''}`
        const header = document.createElement('div')
        header.className = 'tasks-fixup-header'
        const filesEl = document.createElement('div')
        filesEl.className = 'tasks-commit-files hidden'
        const expandBtn = iconBtn('chevron-down', taskT('viewCommitCode'), async () => {
          const opening = filesEl.classList.contains('hidden')
          filesEl.classList.toggle('hidden', !opening)
          if (!opening || filesEl.childElementCount > 0) return
          filesEl.replaceChildren(...buildCommitFileList(
            commitFiles,
            file => invoke<string>('git_show_commit_diff', { path: wt.path, hash: entry.hash, file }),
            file => invoke<string>('git_show_file', { path: wt.path, hash: entry.hash, file }),
          ))
        })
        expandBtn.className = 'tasks-expand-btn'
        const chooseBtn = Object.assign(document.createElement('button'), {
          className: 'tasks-commit-btn',
          textContent: taskT('addHere'),
        })
        const statusEl = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
        chooseBtn.addEventListener('click', async () => {
          const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: baseBranch }).catch(() => null)
          if (preflight?.operation) {
            statusEl.textContent = taskT('operationInProgress', { operation: preflight.operation })
            return
          }
          const publishedWarning = preflight?.publishedCommits
            ? taskT('publishedFixup', { count: preflight.publishedCommits }) : ''
          const ok = await askConfirm(
            taskT('fixupPreview', { count: incomingFiles.size, target: `${entry.short} ${entry.subject}`, matches: overlap.length ? overlap.join(', ') : taskT('none'), blame: blame.score || taskT('none'), history: history.score ? history.files.join(', ') : taskT('none'), published: publishedWarning }),
            { title: taskT('applyFixup'), kind: 'warning' },
          )
          if (!ok) return
          list.querySelectorAll('button').forEach(button => { button.disabled = true })
          statusEl.textContent = taskT('fixupRunning')
          try {
            const result = await invoke<string>('git_fixup', { path: wt.path, target: entry.hash, base: baseBranch, files, patch: selectedPatch })
            recordOperation(wt, 'fixup + autosquash', 'success', `${entry.short} ${entry.subject}`)
            if (result === 'paused') {
              showRebasePaused(wt, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }))
              return
            }
            statusEl.textContent = taskT('changesIntegrated')
            setTimeout(() => { showChanges(wt); load() }, 900)
          } catch (e) {
            recordOperation(wt, 'fixup + autosquash', 'error', String(e))
            statusEl.textContent = String(e).slice(0, 160)
            list.querySelectorAll('button').forEach(button => { button.disabled = false })
          }
        })
        header.append(
          expandBtn,
          Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: entry.short }),
          Object.assign(document.createElement('span'), { className: 'tasks-rebase-subject', textContent: entry.subject }),
          ...(overlap.length ? [Object.assign(document.createElement('span'), {
            className: 'tasks-fixup-match-badge',
            textContent: taskT('recommendedMatch', { count: overlap.length }),
            title: overlap.join('\n'),
          })] : []),
          ...(blame.score ? [Object.assign(document.createElement('span'), {
            className: 'tasks-fixup-blame-badge',
            textContent: taskT('blameLines', { count: blame.score }),
            title: taskT('blameHint', { files: blame.files.join(', ') }),
          })] : []),
          ...(!overlap.length && !blame.score && history.score ? [Object.assign(document.createElement('span'), {
            className: 'tasks-fixup-history-badge',
            textContent: taskT('historyScore', { count: history.score }),
            title: taskT('historyHint', { files: history.files.join(', ') }),
          })] : []),
          statusEl,
          chooseBtn,
        )
        item.append(header, filesEl)
        list.appendChild(item)
      }
      wrap.appendChild(list)
      showDetail(wrap)
    } catch (e) {
      showDetail(note(String(e), 'db-detail-error'))
    }
  }

  // ---- detail: automatic history backups ----
  async function showBackupHistory(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loadingBackups'), 'db-detail-loading'))
    try {
      showDetail(await buildBackupHistoryView({
        path: wt.path, branch: wt.branch ?? '', renderPatch: renderPatchHtml,
        onBack: () => showChanges(wt),
        onRestored: async () => { await load(); showChanges(wt) },
        onOperation: (status, detail) => recordOperation(wt, taskT('restoreBackup'), status, detail),
      }))
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function showOperationHistory(wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    const branch = wt.branch ?? taskT('detached')
    showDetail(buildOperationHistoryView({
      branch,
      repository: repoPath,
      entries: panelStore.operations(),
      onBack: () => showChanges(wt),
      onClear: () => {
        panelStore.clearOperations(repoPath, branch)
        showOperationHistory(wt)
      },
    }))
  }

  // ---- detail: reset commits ----
  function showResetView(wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}

    const wrap = document.createElement('div')
    wrap.className = 'tasks-reset-wrap'
    wrap.append(buildSubHead(taskT('resetTitle', { branch: wt.branch ?? '' }), () => showChanges(wt)))

    const descEl = Object.assign(document.createElement('p'), {
      className: 'tasks-rebase-hint',
      textContent: taskT('resetHint'),
    })
    wrap.appendChild(descEl)

    const form = document.createElement('div')
    form.className = 'tasks-reset-form'

    const targetLabel = Object.assign(document.createElement('label'), { className: 'tasks-reset-label', textContent: taskT('resetTo') })
    const targetInput = Object.assign(document.createElement('input'), {
      className: 'tasks-name-input',
      type: 'text',
      value: `origin/${baseBranch}`,
    })
    form.append(targetLabel, targetInput)

    const modeLabel = Object.assign(document.createElement('label'), { className: 'tasks-reset-label', textContent: taskT('mode') })
    const modeGroup = document.createElement('div')
    modeGroup.className = 'tasks-reset-modes'

    const modes: { value: string; label: string; desc: string }[] = [
      { value: 'mixed', label: taskT('mixedLabel'), desc: taskT('mixedDesc') },
      { value: 'soft',  label: 'Soft', desc: taskT('softDesc') },
      { value: 'hard',  label: 'Hard ⚠', desc: taskT('hardDesc') },
    ]
    let selectedMode = 'mixed'
    modes.forEach(m => {
      const row = document.createElement('label')
      row.className = 'tasks-reset-mode-row'
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'reset-mode', value: m.value })
      radio.checked = m.value === 'mixed'
      radio.addEventListener('change', () => { selectedMode = m.value; resetBtn.classList.toggle('tasks-reset-danger', m.value === 'hard') })
      const nameEl = Object.assign(document.createElement('span'), { className: 'tasks-reset-mode-name', textContent: m.label })
      const descEl2 = Object.assign(document.createElement('span'), { className: 'tasks-reset-mode-desc', textContent: m.desc })
      row.append(radio, nameEl, descEl2)
      modeGroup.appendChild(row)
    })
    form.append(modeLabel, modeGroup)
    wrap.appendChild(form)

    const footer = document.createElement('div')
    footer.className = 'tasks-rebase-paused-actions'
    const statusEl = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
    const resetBtn = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('reset') })

    resetBtn.addEventListener('click', async () => {
      const target = targetInput.value.trim()
      if (!target) return
      if (selectedMode === 'hard') {
        const ok = await askConfirm(
          taskT('hardResetQuestion', { target }),
          { title: taskT('hardResetTitle'), kind: 'warning' }
        )
        if (!ok) return
      }
      resetBtn.disabled = true
      statusEl.textContent = taskT('running')
      try {
        await invoke('git_reset', { path: wt.path, target, mode: selectedMode })
        recordOperation(wt, `reset --${selectedMode}`, 'success', target)
        statusEl.textContent = taskT('resetDone', { target })
        setTimeout(() => { showChanges(wt); load() }, 900)
      } catch (e) {
        recordOperation(wt, `reset --${selectedMode}`, 'error', String(e))
        statusEl.textContent = String(e).slice(0, 160)
        resetBtn.disabled = false
      }
    })

    footer.append(statusEl, resetBtn)
    wrap.appendChild(footer)
    showDetail(wrap)
  }

  // ---- detail: commit log ----
  async function showCommitGraph(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loadingGraph'), 'db-detail-loading'))
    try {
      const raw = await invoke<string>('git_graph', { path: wt.path, base: baseBranch })
      const wrap = document.createElement('div')
      wrap.className = 'tasks-graph-wrap'
      wrap.append(buildSubHead(taskT('graphTitle', { branch: wt.branch ?? '', base: baseBranch }), () => showChanges(wt)))
      const legend = Object.assign(document.createElement('p'), {
        className: 'tasks-rebase-hint',
        textContent: taskT('graphHint'),
      })
      const graph = document.createElement('pre')
      graph.className = 'tasks-git-graph'
      graph.innerHTML = raw.split('\n').map(line => escHtml(line)
        .replace(/\b([0-9a-f]{7,40})\b/, '<span class="tasks-graph-hash">$1</span>')
        .replace(/\(([^)]+)\)/g, '<span class="tasks-graph-ref">($1)</span>')).join('\n')
      wrap.append(legend, graph)
      showDetail(wrap)
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function showPrDetails(wt: Worktree, pr: PrStatus): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(buildPrStatusView({
      pr, baseBranch,
      onBack: () => showChanges(wt),
      onOpen: () => openUrl(pr.url).catch(() => {}),
    }))
  }

  async function showCommitLog(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loadingHistory'), 'db-detail-loading'))
    try {
      const entries = await taskGit.log(wt.path)
      const wrap = document.createElement('div')
      wrap.className = 'tasks-log-wrap'
      wrap.append(buildSubHead(taskT('historyTitle', { branch: wt.branch ?? '' }), () => showChanges(wt)))
      const list = document.createElement('div')
      list.className = 'tasks-log-list'
      if (entries.length === 0) {
        list.appendChild(note(taskT('noBranchCommits'), 'db-detail-hint'))
      }
      for (const e of entries) {
        const item = document.createElement('div')
        item.className = 'tasks-log-item'
        const shortEl = Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: e.short })
        const subjectEl = Object.assign(document.createElement('span'), { className: 'tasks-log-subject', textContent: e.subject })
        const metaEl = Object.assign(document.createElement('span'), {
          className: 'tasks-log-meta',
          textContent: `${e.author} · ${e.date}`,
        })
        let filesLoaded = false
        const filesEl = document.createElement('div')
        filesEl.className = 'tasks-commit-files hidden'
        const expandBtn = iconBtn('chevron-down', taskT('viewCommitFiles'), async () => {
          const isOpen = !filesEl.classList.contains('hidden')
          if (isOpen) { filesEl.classList.add('hidden'); expandBtn.title = taskT('viewCommitFiles'); return }
          filesEl.classList.remove('hidden'); expandBtn.title = taskT('hideFiles')
          if (filesLoaded) return
          filesLoaded = true
          filesEl.textContent = taskT('loading')
          const files = await taskGit.files(wt.path, e.hash).catch(() => [])
          filesEl.replaceChildren(...buildCommitFileList(
            files,
            file => invoke<string>('git_show_commit_diff', { path: wt.path, hash: e.hash, file }),
            file => invoke<string>('git_show_file', { path: wt.path, hash: e.hash, file }),
          ))
        })
        expandBtn.className = 'tasks-expand-btn'
        const header = document.createElement('div')
        header.className = 'tasks-log-item-header'
        header.append(shortEl, subjectEl, metaEl, expandBtn)
        item.append(header, filesEl)
        list.appendChild(item)
      }
      wrap.appendChild(list)
      showDetail(wrap)
    } catch (err) { showDetail(note(String(err), 'db-detail-error')) }
  }

  // ---- detail: interactive rebase ----
  async function showInteractiveRebase(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loading'), 'db-detail-loading'))
    try {
      const st = await invoke<RebaseStatus>('git_rebase_status', { path: wt.path })
      if (st.active) { showRebasePaused(wt, st); return }

      const [entries, merges] = await Promise.all([
        taskGit.rebaseLog(wt.path, baseBranch),
        taskGit.mergeLog(wt.path, baseBranch).catch(() => []),
      ])
      if (entries.length === 0) {
        showDetail(note(taskT('noOwnCommits', { base: baseBranch }), 'db-detail-hint'))
        return
      }
      if (merges.length) showMergeRebaseWarning(wt, entries, merges)
      else showRebaseEditor(wt, entries)
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function showMergeRebaseWarning(wt: Worktree, entries: CommitEntry[], merges: CommitEntry[]): void {
    const wrap = document.createElement('div')
    wrap.className = 'tasks-rebase-wrap'
    wrap.append(buildSubHead(taskT('branchHasMerges'), () => showChanges(wt)))
    wrap.appendChild(Object.assign(document.createElement('p'), {
      className: 'tasks-rebase-hint tasks-conflict-warning',
      textContent: taskT('mergesWarning', { count: merges.length }),
    }))
    const list = document.createElement('div')
    list.className = 'tasks-log-list'
    for (const merge of merges) {
      const row = document.createElement('div')
      row.className = 'tasks-log-item'
      row.append(
        Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: merge.short }),
        Object.assign(document.createElement('span'), { className: 'tasks-log-subject', textContent: merge.subject }),
      )
      list.appendChild(row)
    }
    wrap.appendChild(list)
    const footer = document.createElement('div')
    footer.className = 'tasks-rebase-footer'
    const status = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
    const flattenBtn = Object.assign(document.createElement('button'), { className: 'tasks-amend-btn', textContent: taskT('flatten') })
    const preserveBtn = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('preserveMerges') })
    flattenBtn.addEventListener('click', async () => {
      const ok = await askConfirm(taskT('flattenQuestion'), { title: taskT('flattenTitle'), kind: 'warning' })
      if (ok) showRebaseEditor(wt, entries)
    })
    preserveBtn.addEventListener('click', async () => {
      const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: baseBranch }).catch(() => null)
      if (preflight?.operation) { status.textContent = taskT('operationInProgress', { operation: preflight.operation }); return }
      const ok = await askConfirm(
        taskT('preserveQuestion', { count: merges.length, published: preflight?.publishedCommits ? ` ${preflight.publishedCommits} commit(s).` : '' }),
        { title: taskT('preserveTitle'), kind: 'warning' },
      )
      if (!ok) return
      preserveBtn.disabled = true; flattenBtn.disabled = true
      status.textContent = taskT('reorganizingMerges')
      try {
        const result = await invoke<string>('git_rebase_preserve_merges', { path: wt.path, base: baseBranch })
        recordOperation(wt, 'rebase --rebase-merges', 'success', `origin/${baseBranch}`)
        if (result === 'paused') {
          showRebasePaused(wt, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }))
        } else { status.textContent = taskT('rebaseDone'); setTimeout(() => { showChanges(wt); load() }, 900) }
      } catch (e) {
        recordOperation(wt, 'rebase --rebase-merges', 'error', String(e))
        status.textContent = String(e).slice(0, 150); preserveBtn.disabled = false; flattenBtn.disabled = false
      }
    })
    footer.append(status, flattenBtn, preserveBtn)
    wrap.appendChild(footer)
    showDetail(wrap)
  }

  function showRebaseEditor(wt: Worktree, entries: CommitEntry[]): void {
    type RebaseItem = RebasePlanItem & { action: RebaseAction; newMessage: string }
    const items: RebaseItem[] = entries.map(e => ({ action: 'pick', hash: e.hash, short: e.short, subject: e.subject, newMessage: '' }))
    const ACTIONS: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']
    let draggedIndex: number | null = null
    let dragTarget: { index: number; after: boolean } | null = null

    const wrap = document.createElement('div')
    wrap.className = 'tasks-rebase-wrap'
    wrap.append(buildSubHead(taskT('interactiveTitle', { branch: wt.branch ?? '', base: baseBranch }), () => showChanges(wt)))

    const hint = Object.assign(document.createElement('p'), {
      className: 'tasks-rebase-hint',
      textContent: taskT('rebaseOrderHint'),
    })
    wrap.appendChild(hint)

    const previewEl = document.createElement('div')
    previewEl.className = 'tasks-rebase-preview hidden'
    const renderPreview = (): void => {
      const content = buildRebasePlanPreview(items)
      previewEl.replaceChildren(...content.childNodes)
    }
    wrap.appendChild(previewEl)

    const list = document.createElement('div')
    list.className = 'tasks-rebase-list'

    const renderList = (): void => {
      list.replaceChildren()
      items.forEach((item, idx) => {
        const row = document.createElement('div')
        row.className = `tasks-rebase-item${item.action === 'drop' ? ' tasks-rebase-drop' : ''}`
        row.dataset.testid = 'tasks-rebase-item'
        row.dataset.hash = item.hash
        row.tabIndex = 0
        row.setAttribute('role', 'listitem')
        row.setAttribute('aria-label', taskT('rebaseItemAria', {
          action: item.action,
          hash: item.short,
          subject: item.subject,
        }))

        const dragHandle = Object.assign(document.createElement('button'), {
          className: 'tasks-rebase-drag',
          textContent: '⠿',
          title: taskT('dragCommit'),
        })
        dragHandle.setAttribute('aria-label', taskT('moveCommit', { commit: item.short }))

        const clearDragStyles = (): void => {
          list.querySelectorAll('.tasks-rebase-item').forEach(el => {
            el.classList.remove('tasks-rebase-dragging', 'tasks-rebase-drag-before', 'tasks-rebase-drag-after')
          })
        }

        dragHandle.addEventListener('pointerdown', e => {
          if (e.button !== 0) return
          e.preventDefault()
          draggedIndex = idx
          dragTarget = null
          dragHandle.setPointerCapture(e.pointerId)
          row.classList.add('tasks-rebase-dragging')
        })
        dragHandle.addEventListener('pointermove', e => {
          if (draggedIndex === null || !dragHandle.hasPointerCapture(e.pointerId)) return
          e.preventDefault()
          const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tasks-rebase-item') as HTMLElement | null
          if (!targetEl) return
          const rows = [...list.querySelectorAll<HTMLElement>('.tasks-rebase-item')]
          const targetIndex = rows.indexOf(targetEl)
          clearDragStyles()
          row.classList.add('tasks-rebase-dragging')
          if (targetIndex < 0 || targetIndex === draggedIndex) {
            dragTarget = null
            return
          }
          const rect = targetEl.getBoundingClientRect()
          const after = e.clientY > rect.top + rect.height / 2
          dragTarget = { index: targetIndex, after }
          targetEl.classList.add(after ? 'tasks-rebase-drag-after' : 'tasks-rebase-drag-before')
        })
        const finishPointerDrag = (e: PointerEvent): void => {
          if (draggedIndex === null) return
          e.preventDefault()
          const from = draggedIndex
          draggedIndex = null
          clearDragStyles()
          if (!dragTarget) return
          const { index, after } = dragTarget
          dragTarget = null
          const [moved] = items.splice(from, 1)
          let target = index + (after ? 1 : 0)
          if (from < target) target--
          items.splice(target, 0, moved)
          renderList()
        }
        dragHandle.addEventListener('pointerup', finishPointerDrag)
        dragHandle.addEventListener('pointercancel', finishPointerDrag)

        const select = document.createElement('select')
        select.className = 'tasks-rebase-action'
        ACTIONS.forEach(a => {
          const opt = Object.assign(document.createElement('option'), { value: a, textContent: a })
          opt.selected = a === item.action
          select.appendChild(opt)
        })
        select.addEventListener('change', () => {
          item.action = select.value as RebaseAction
          row.className = `tasks-rebase-item${item.action === 'drop' ? ' tasks-rebase-drop' : ''}`
          renderList() // re-render to show/hide reword input
        })

        const hashEl = Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: item.short })

        // For reword: show editable input; otherwise show static subject
        const contentEl = document.createElement('div')
        contentEl.className = 'tasks-rebase-content'
        if (item.action === 'reword') {
          const msgIn = Object.assign(document.createElement('input'), {
            className: 'tasks-rebase-reword-input',
            type: 'text',
            value: item.newMessage || item.subject,
            placeholder: taskT('newCommitTitle'),
          })
          msgIn.addEventListener('input', () => { item.newMessage = msgIn.value })
          msgIn.addEventListener('click', e => e.stopPropagation())
          contentEl.appendChild(msgIn)
        } else {
          contentEl.appendChild(Object.assign(document.createElement('span'), {
            className: 'tasks-rebase-subject',
            textContent: item.subject,
          }))
        }

        const upBtn = iconBtn('chevron-up', taskT('moveUp'), () => {
          if (idx === 0) return
          ;[items[idx - 1], items[idx]] = [items[idx], items[idx - 1]]
          renderList()
        })
        const downBtn = iconBtn('chevron-down', taskT('moveDown'), () => {
          if (idx === items.length - 1) return
          ;[items[idx + 1], items[idx]] = [items[idx], items[idx + 1]]
          renderList()
        })
        upBtn.disabled = idx === 0
        downBtn.disabled = idx === items.length - 1

        row.addEventListener('keydown', e => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
          e.preventDefault()
          const target = e.key === 'ArrowUp' ? idx - 1 : idx + 1
          if (target < 0 || target >= items.length) return
          ;[items[target], items[idx]] = [items[idx], items[target]]
          renderList()
          list.querySelectorAll<HTMLElement>('.tasks-rebase-item')[target]?.focus()
        })

        const moveEl = document.createElement('div')
        moveEl.className = 'tasks-rebase-move'
        moveEl.append(upBtn, downBtn)

        // Expand/collapse files changed in this commit
        let filesLoaded = false
        const filesEl = document.createElement('div')
        filesEl.className = 'tasks-commit-files hidden'
        const expandBtn = iconBtn('chevron-down', taskT('viewCommitFiles'), async () => {
          const isOpen = !filesEl.classList.contains('hidden')
          if (isOpen) { filesEl.classList.add('hidden'); expandBtn.title = taskT('viewCommitFiles'); return }
          filesEl.classList.remove('hidden'); expandBtn.title = taskT('hideFiles')
          if (filesLoaded) return
          filesLoaded = true
          filesEl.textContent = taskT('loading')
          const files = await taskGit.files(wt.path, item.hash).catch(() => [])
          filesEl.replaceChildren(...buildCommitFileList(
            files,
            file => invoke<string>('git_show_commit_diff', { path: wt.path, hash: item.hash, file }),
            file => invoke<string>('git_show_file', { path: wt.path, hash: item.hash, file }),
          ))
        })
        expandBtn.className = 'tasks-expand-btn'

        row.append(dragHandle, select, hashEl, contentEl, moveEl, expandBtn)
        row.appendChild(filesEl)
        list.appendChild(row)
      })
    }
    renderList()
    wrap.appendChild(list)

    const footer = document.createElement('div')
    footer.className = 'tasks-rebase-footer'
    const statusEl = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })
    const previewBtn = Object.assign(document.createElement('button'), { className: 'tasks-amend-btn', textContent: taskT('simulate') })
    previewBtn.dataset.testid = 'tasks-rebase-preview'
    previewBtn.addEventListener('click', () => {
      renderPreview()
      previewEl.classList.toggle('hidden')
      previewBtn.textContent = previewEl.classList.contains('hidden') ? taskT('simulate') : taskT('hideSimulation')
    })
    const startBtn = Object.assign(document.createElement('button'), {
      className: 'tasks-commit-btn',
      textContent: taskT('startRebase'),
    })
    startBtn.dataset.testid = 'tasks-rebase-start'
    startBtn.addEventListener('click', async () => {
      const preview = previewRebase(items)
      if (preview.warnings.length) {
        statusEl.textContent = preview.warnings.join(' ')
        previewEl.classList.remove('hidden'); renderPreview()
        return
      }
      let preflight: RewritePreflight
      try {
        preflight = await invoke<RewritePreflight>('git_rewrite_preflight', { path: wt.path, base: baseBranch })
      } catch (e) {
        statusEl.textContent = taskT('validationError', { error: String(e).slice(0, 100) })
        return
      }
      if (preflight.operation) {
        statusEl.textContent = taskT('operationInProgress', { operation: preflight.operation })
        return
      }
      const risks = [
        preflight.dirty ? taskT('dirtyRisk') : '',
        preflight.publishedCommits ? taskT('publishedRisk', { count: preflight.publishedCommits }) : '',
        preflight.protectedBase ? taskT('protectedRisk', { branch: preflight.branch }) : '',
        preflight.hooks.length ? taskT('hooksRisk', { hooks: preflight.hooks.join(', ') }) : '',
        preflight.signing ? taskT('signingRisk') : '',
      ].filter(Boolean)
      const confirmed = await askConfirm(
        taskT('rebaseQuestion', { result: preview.resultingCommits, combined: preview.combinedCommits, dropped: preview.droppedCommits, risks: risks.length ? `\n\n${risks.join('\n')}` : '' }),
        { title: taskT('confirmRebase'), kind: risks.length ? 'warning' : 'info' },
      )
      if (!confirmed) return
      startBtn.disabled = true
      statusEl.textContent = taskT('running')
      // reword → convert to edit in the git todo; the new message is applied in the paused UI
      const rewordMessages = new Map(items.filter(i => i.action === 'reword').map(i => [i.hash, i.newMessage || i.subject]))
      const todoLines = items.map(i => `${i.action === 'reword' ? 'edit' : i.action} ${i.hash} ${i.subject}`)
      try {
        await invoke('git_rebase_start', { path: wt.path, base: baseBranch, todoLines })
        recordOperation(wt, 'rebase interactivo', 'success', `${items.length} instrucciones sobre origin/${baseBranch}`)
        const st = await invoke<RebaseStatus>('git_rebase_status', { path: wt.path })
        if (st.active) {
          // If this commit was a reword, pre-fill the message with the new title
          const preMsg = rewordMessages.get(st.sha ?? '') ?? st.subject ?? ''
          showRebasePaused(wt, { ...st, subject: preMsg })
          return
        }
        statusEl.textContent = taskT('rebaseComplete')
        setTimeout(() => { showChanges(wt); load() }, 1200)
      } catch (e) {
        recordOperation(wt, 'rebase interactivo', 'error', String(e))
        statusEl.textContent = String(e).slice(0, 120)
        startBtn.disabled = false
      }
    })
    footer.append(statusEl, previewBtn, startBtn)
    wrap.appendChild(footer)
    showDetail(wrap)
  }

  // ---- Inline conflict resolver ----
  function showConflictResolver(wt: Worktree, file: string, onBack: () => void): void {
    stopDiffRefresh()
    showDetail(buildConflictResolverView({ path: wt.path, file, onBack }))
  }

  function showRebasePaused(wt: Worktree, st: RebaseStatus): void {
    const wrap = document.createElement('div')
    wrap.className = 'tasks-rebase-paused'

    wrap.append(buildSubHead(taskT('pausedTitle', { branch: wt.branch ?? '' }), () => showChanges(wt)))

    const infoEl = document.createElement('div')
    infoEl.className = 'tasks-rebase-paused-info'
    infoEl.append(
      Object.assign(document.createElement('span'), {
        className: 'tasks-rebase-paused-label',
        textContent: st.total
          ? taskT('rebaseProgressColon', { current: st.current ?? 0, total: st.total })
          : taskT('editing'),
      }),
      Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: st.short ?? '' }),
      Object.assign(document.createElement('span'), { className: 'tasks-rebase-subject', textContent: st.subject ?? '' }),
    )
    wrap.appendChild(infoEl)

    const actionsEl = document.createElement('div')
    actionsEl.className = 'tasks-rebase-paused-actions'
    const statusEl = Object.assign(document.createElement('span'), { className: 'tasks-rebase-status-msg' })

    const abortBtn = Object.assign(document.createElement('button'), { className: 'tasks-amend-btn', textContent: taskT('abortRebase') })
    const editBtn = Object.assign(document.createElement('button'), {
      className: 'tasks-amend-btn',
      textContent: taskT('editCommit'),
      title: taskT('editHint'),
    })
    const splitBtn = Object.assign(document.createElement('button'), {
      className: 'tasks-amend-btn',
      textContent: taskT('splitCommit'),
      title: taskT('splitHint'),
    })
    const continueBtn = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('continueRebase') })

    let intervalId = 0

    editBtn.addEventListener('click', () => showChanges(wt))
    splitBtn.addEventListener('click', async () => {
      const ok = await askConfirm(
        taskT('splitQuestion'),
        { title: taskT('splitTitle'), kind: 'warning' },
      )
      if (!ok) return
      splitBtn.disabled = true
      try {
        await invoke('git_rebase_split', { path: wt.path })
        recordOperation(wt, 'dividir commit', 'success', st.short ?? st.subject ?? '')
        showChanges(wt)
      } catch (e) {
        recordOperation(wt, 'dividir commit', 'error', String(e))
        statusEl.textContent = String(e).slice(0, 140)
        splitBtn.disabled = false
      }
    })

    continueBtn.addEventListener('click', async () => {
      continueBtn.disabled = true; abortBtn.disabled = true
      statusEl.textContent = taskT('continuing')
      clearInterval(intervalId)
      try {
        const result = await invoke<string>('git_rebase_continue', { path: wt.path })
        if (result === 'paused') {
          showRebasePaused(wt, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }))
        } else {
          statusEl.textContent = taskT('rebaseComplete')
          setTimeout(() => { showChanges(wt); load() }, 1200)
        }
      } catch (e) {
        statusEl.textContent = String(e).slice(0, 120)
        continueBtn.disabled = false; abortBtn.disabled = false
      }
    })

    abortBtn.addEventListener('click', async () => {
      const ok = await askConfirm(taskT('abortQuestion'), { title: taskT('abortRebase'), kind: 'warning' })
      if (!ok) return
      await invoke('git_rebase_abort', { path: wt.path }).catch(() => {})
      clearInterval(intervalId)
      showChanges(wt); load()
    })

    const conflicts = st.conflicts ?? []
    editBtn.disabled = conflicts.length > 0
    splitBtn.disabled = conflicts.length > 0

    if (conflicts.length > 0) {
      // ---- Conflict resolution mode ----
      const warningEl = Object.assign(document.createElement('p'), {
        className: 'tasks-rebase-hint tasks-conflict-warning',
        textContent: taskT('conflictWarning', { count: conflicts.length }),
      })
      wrap.appendChild(warningEl)

      const conflictList = document.createElement('div')
      conflictList.className = 'tasks-conflict-list'

      const resolved = new Set<string>()

      const renderConflicts = (currentConflicts: string[]): void => {
        conflictList.replaceChildren()
        currentConflicts.forEach(file => {
          const isResolved = resolved.has(file)
          const row = document.createElement('div')
          row.className = `tasks-conflict-row${isResolved ? ' tasks-conflict-resolved' : ''}`

          const fileEl = Object.assign(document.createElement('span'), {
            className: 'tasks-conflict-file',
            textContent: file,
            title: file,
          })

          const btns = document.createElement('div')
          btns.className = 'tasks-conflict-btns'

          if (!isResolved) {
            const resolveBtn = Object.assign(document.createElement('button'), { className: 'tasks-conflict-btn tasks-conflict-btn-primary', textContent: taskT('resolveHere') })
            resolveBtn.title = taskT('openConflictResolver')
            resolveBtn.addEventListener('click', () => {
              clearInterval(intervalId)
              showConflictResolver(wt, file, () => {
                resolved.add(file)
                showRebasePaused(wt, st)
              })
            })

            const oursBtn = Object.assign(document.createElement('button'), { className: 'tasks-conflict-btn', textContent: taskT('currentVersion') })
            oursBtn.title = taskT('keepOursHint')
            oursBtn.addEventListener('click', async () => {
              oursBtn.disabled = true
              await invoke('git_resolve_conflict', { path: wt.path, file, side: 'ours' }).catch(e => { statusEl.textContent = String(e); oursBtn.disabled = false })
              resolved.add(file)
              renderConflicts(currentConflicts)
            })

            const theirsBtn = Object.assign(document.createElement('button'), { className: 'tasks-conflict-btn', textContent: taskT('appliedCommit') })
            theirsBtn.title = taskT('keepTheirsHint')
            theirsBtn.addEventListener('click', async () => {
              theirsBtn.disabled = true
              await invoke('git_resolve_conflict', { path: wt.path, file, side: 'theirs' }).catch(e => { statusEl.textContent = String(e); theirsBtn.disabled = false })
              resolved.add(file)
              renderConflicts(currentConflicts)
            })

            btns.append(resolveBtn, oursBtn, theirsBtn)
          } else {
            btns.appendChild(Object.assign(document.createElement('span'), { className: 'tasks-conflict-done', textContent: taskT('resolved') }))
          }

          row.append(fileEl, btns)
          conflictList.appendChild(row)
        })

        // Auto-update Continue button: enabled when all current conflicts are resolved
        const allResolved = currentConflicts.every(f => resolved.has(f))
        continueBtn.disabled = !allResolved
      }

      renderConflicts(conflicts)
      wrap.appendChild(conflictList)

      // Auto-refresh conflict list in case user resolves from terminal
      intervalId = window.setInterval(async () => {
        const fresh = await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => null)
        if (!fresh) return
        if (!fresh.active) { clearInterval(intervalId); showChanges(wt); load(); return }
        const freshConflicts = fresh.conflicts ?? []
        freshConflicts.forEach(f => { if (!freshConflicts.includes(f)) resolved.delete(f) })
        if (freshConflicts.length === 0) {
          clearInterval(intervalId)
          showRebasePaused(wt, fresh)
        } else {
          renderConflicts(freshConflicts)
        }
      }, 4000)

      continueBtn.disabled = conflicts.length > 0

    } else {
      // ---- Normal edit mode (intentional `edit` step) ----
      const hintEl = Object.assign(document.createElement('p'), {
        className: 'tasks-rebase-hint',
        textContent: taskT('amendPausedHint'),
      })
      wrap.appendChild(hintEl)

      const diffWrap = document.createElement('div')
      diffWrap.className = 'tasks-rebase-diff'
      const refreshDiff = (): void => {
        invoke<string>('git_diff', { path: wt.path }).then(raw => {
          diffWrap.replaceChildren(buildDiffView(raw, wt, { initAmend: true, initMessage: st.subject ?? '' }))
        }).catch(() => {})
      }
      refreshDiff()
      intervalId = window.setInterval(refreshDiff, 5000)
      wrap.appendChild(diffWrap)
    }

    detailCleanup = () => clearInterval(intervalId)
    actionsEl.append(statusEl, abortBtn, editBtn, splitBtn, continueBtn)
    wrap.appendChild(actionsEl)
    showDetail(wrap)
  }

  // ---- detail: worktree terminal ----
  async function showWorktreeTerminal(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    const { createTerminalPanel } = await import('../terminal/TerminalPanel')
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const termBody = document.createElement('div')
    termBody.className = 'tasks-term-body'
    const term = createTerminalPanel('', wt.path, () => showChanges(wt))
    termBody.appendChild(term.element)
    wrap.append(buildSubHead(`Terminal · ${wt.branch ?? ''}`, () => showChanges(wt)), termBody)
    showDetail(wrap)
    requestAnimationFrame(() => term.fit())
    detailCleanup = () => term.dispose()
  }

  // ---- detail: git sync error (with conflict detection + AI explain) ----
  function showSyncError(mode: string, errorText: string, wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    const wrap = document.createElement('div')
    wrap.className = 'tasks-sync-error'

    const head = document.createElement('div')
    head.className = 'tasks-sync-error-head'
    head.append(
      Object.assign(document.createElement('span'), { className: 'tasks-sync-error-title', textContent: taskT('errorIn', { mode }) }),
      iconBtn('chat', taskT('explainAi'), () => {
        askAi(`/explica este error de git al hacer \`${mode}\`:\n\n\`\`\`\n${errorText.slice(-8000)}\n\`\`\``, true)
      }),
    )

    const pre = Object.assign(document.createElement('pre'), { className: 'tasks-sync-error-body', textContent: errorText })
    wrap.append(head, pre)

    // Detect and display conflicted files so the user can open them directly
    const isConflict = /conflict|CONFLICT/i.test(errorText)
    if (isConflict) {
      taskGit.status(wt.path).then(status => {
        const conflicts = parseConflictFiles(status.raw)
        if (conflicts.length === 0) return
        const conflictsEl = document.createElement('div')
        conflictsEl.className = 'tasks-conflicts'
        conflictsEl.appendChild(Object.assign(document.createElement('div'), {
          className: 'tasks-conflicts-title',
          textContent: taskT('conflictFiles', { count: conflicts.length }),
        }))
        for (const f of conflicts) {
          const row = document.createElement('div')
          row.className = 'tasks-conflict-file'
          row.append(
            Object.assign(document.createElement('span'), { className: 'tasks-conflict-name', textContent: f }),
            iconBtn('edit', taskT('openInEditor'), () => {
              invoke('open_in_editor', { path: `${wt.path}/${f}` }).catch(console.error)
            }),
          )
          conflictsEl.appendChild(row)
        }
        wrap.appendChild(conflictsEl)
      }).catch(() => {})
    }

    showDetail(wrap)
  }

  // ---- mutations ----
  async function createTask(name: string): Promise<void> {
    if (!name || !repoPath) return
    const branch = taskBranch(name)
    const path = taskPath(repoPath, branch.slice('feat/'.length))
    listWrap.replaceChildren(note(taskT('creatingTask'), 'db-detail-loading'))
    try {
      const base = await invoke<string>('git_default_branch', { repo: repoPath })
      await invoke('git_worktree_add', { repo: repoPath, path, branch, base })
      await load()
      const wt = worktrees.find(w => w.path === path)
      const result = await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: path }).catch((e: unknown) => {
        const msg = String(e); if (msg !== 'no-compose') showDetail(note(msg, 'db-detail-error')); return null
      })
      if (result && wt) dockerView.show(result, wt)
    } catch (e) { listWrap.replaceChildren(note(String(e), 'db-detail-error')) }
  }

  async function deleteWorktree(wt: Worktree): Promise<void> {
    const { total } = await taskGit.safeStatus(wt.path)
    const ok = await askConfirm(
      total > 0 ? taskT('deleteDirtyQuestion', { branch: wt.branch ?? '', count: total }) : taskT('deleteQuestion', { branch: wt.branch ?? '' }),
      { title: taskT('deleteTask'), kind: total > 0 ? 'warning' : 'info' },
    )
    if (!ok) return
    try {
      await invoke('docker_compose_down', { worktreePath: wt.path }).catch(() => {})
      await invoke('git_worktree_remove', { repo: repoPath, path: wt.path, force: total > 0, branch: wt.branch ?? null })
      showDetail(note(taskT('selectTask'), 'db-detail-hint'))
      await load()
    } catch (e) { await askConfirm(String(e), { title: taskT('genericError'), kind: 'error' }) }
  }

  // ---- load ----
  async function load(): Promise<void> {
    if (!repoPath) {
      baseSelect.disabled = true
      filterInput.style.display = 'none'
      listWrap.replaceChildren(note(taskT('selectRepoHint')), buildCreateForm())
      return
    }
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
      baseBranch = savedBase && remoteBranches.includes(savedBase) ? savedBase : defaultBranch
      panelStore.setBase(baseBranch)
      baseSelect.replaceChildren(...remoteBranches.map(branch => Object.assign(document.createElement('option'), {
        value: branch,
        textContent: taskT('baseOption', { branch }),
        selected: branch === baseBranch,
      })))
      worktrees = await taskGit.worktrees(repoPath)
      if (worktrees[0]) {
        const fetchInfo = await invoke<{ fetchedAt: number }>('git_fetch_info', { path: worktrees[0].path }).catch(() => ({ fetchedAt: 0 }))
        fetchedAt = fetchInfo.fetchedAt
      }
      if (fetchedAt) {
        const ageMinutes = Math.max(0, Math.floor((Date.now() / 1000 - fetchedAt) / 60))
        fetchAgeEl.textContent = ageMinutes < 1 ? taskT('fetchNow') : ageMinutes < 60 ? taskT('fetchMinutes', { count: ageMinutes }) : taskT('fetchHours', { count: Math.floor(ageMinutes / 60) })
        fetchAgeEl.classList.toggle('tasks-fetch-age--stale', ageMinutes > 60)
        fetchAgeEl.title = new Date(fetchedAt * 1000).toLocaleString()
      } else {
        fetchAgeEl.textContent = taskT('noFetch')
        fetchAgeEl.classList.add('tasks-fetch-age--stale')
      }
      jiraCfg = await loadJiraConfig()

      const [statuses, allContainers] = await Promise.all([
        mapWithConcurrency(worktrees, 6, async wt => {
          const status = await taskGit.safeStatus(wt.path)
          return [wt.path, status.total] as [string, number]
        }).then(entries => new Map(entries)),
        invoke<string>('docker_list').catch(() => '').then(parseContainers),
      ])

      // Fetch git/Jira metadata in parallel for all worktrees
      await mapWithConcurrency(worktrees, 4, async wt => {
        const abRaw = await invoke<string>('git_ahead_behind', { path: wt.path, base: baseBranch }).catch(() => '')
        aheadBehindMap.set(wt.path, parseAheadBehind(abRaw))

        const key = extractIssueKey(wt.branch ?? null)
        const issue = key && jiraCfg ? await fetchIssue(key, jiraCfg) : null
        issueMap.set(wt.path, issue)

        // PR status — silent fallback if gh is not installed
        prStatusMap.set(wt.path, await invoke<PrStatus | null>('git_pr_status', { path: wt.path }).catch(() => null))

        backupStatusMap.set(wt.path, await invoke<BackupStatus>('git_backup_status', { path: wt.path }).catch(() => ({ available: false, different: null, hash: null, short: null, subject: null })))

        rebaseStatusMap.set(wt.path, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false, sha: null, short: null, subject: null, body: null, branch: null, current: null, total: null, conflicts: [] })))

        const upstream = await invoke<UpstreamStatus | null>('git_upstream_status', { path: wt.path }).catch(() => null)
        if (upstream) upstreamStatusMap.set(wt.path, upstream); else upstreamStatusMap.delete(wt.path)
      })

      const runningPaths = new Set<string>()
      for (const wt of worktrees) {
        const dir = wt.path.replace(/\/$/, '').split('/').pop()!
        const hasRunning = allContainers.some(c => isRunning(c) && c.name.startsWith(`${dir}-`))
        if (hasRunning) runningPaths.add(wt.path)
      }
      renderList(statuses, runningPaths)

      // Recover an active rebase first; otherwise restore the previously selected task.
      const savedPath = panelStore.selected()
      const activeWt = worktrees.find(w => rebaseStatusMap.get(w.path)?.active)
      const selectedWt = activeWt ?? (savedPath ? worktrees.find(w => w.path === savedPath) : undefined)
      if (selectedWt) {
        const rows = listWrap.querySelectorAll<HTMLElement>('.tasks-row')
        const idx = worktrees.indexOf(selectedWt)
        if (rows[idx]) {
          selectRow(rows[idx])
          panelStore.setSelected(selectedWt.path)
          const rebase = rebaseStatusMap.get(selectedWt.path)
          if (rebase?.active) showRebasePaused(selectedWt, rebase)
          else showChanges(selectedWt)
        }
      }
    } catch (e) { listWrap.replaceChildren(note(String(e), 'db-detail-error')) }
  }

  function iconBtn(name: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'docker-action'
    b.title = title
    b.innerHTML = icon(name)
    b.addEventListener('click', e => { e.stopPropagation(); onClick() })
    return b
  }

  filterInput.style.display = 'none'
  load()
  return { element: root }
}
