import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { open as pickFolder, confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import { parseWorktreeList, parseStatus, taskBranch, taskPath, type Worktree } from '../../core/git/worktree'
import { parseContainers, isRunning, type Container } from '../../core/docker/containers'
import { renderContainerLogs, renderContainerTerminal } from '../docker/containerDetail'
import { showContextMenu } from '../../ui/contextMenu'
import { askAi } from '../../ui/askAi'
import { icon } from '../../ui/icons'
import { extractIssueKey, statusCategoryClass, parseAheadBehind } from '../../core/git/taskJira'
import { diffFileNames, changedPaths, matchingPaths, buildSelectedPatch } from '../../core/git/commitWorkflow'
import { parseConflictFiles } from '../../core/git/conflictWorkflow'
import {
  appendOperation, mapWithConcurrency, previewRebase,
  type GitOperationEntry, type RebaseAction, type RebasePlanItem,
} from '../../core/git/rebaseWorkflow'
import {
  loadJiraConfig, fetchIssue, fetchTransitions, applyTransition, browseUrl,
  type JiraConfig, type TaskIssue,
} from './taskJiraClient'
import { buildOperationHistoryView } from './OperationHistoryView'
import type { BackupStatus, PrStatus, RebaseStatus, RewritePreflight, UpstreamStatus } from './gitTypes'
import { buildPrStatusView } from './PrStatusView'
import { getTaskLocale, setTaskLocale, taskT, type TaskLocale } from './i18n'
import { buildBackupHistoryView } from './BackupHistoryView'
import { buildConflictResolverView } from './ConflictResolverView'
import { buildChangesFileView } from './ChangesFileView'
import { buildRebasePlanPreview } from './RebasePlanView'

interface IsolateResult {
  subnet: string
  urls: { service: string; url: string }[]
}

interface CommitEntry {
  hash: string
  short: string
  subject: string
  date: string
  author: string
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Parses the custom \x1f-separated log format produced by git_log
function parseLogEntries(raw: string): CommitEntry[] {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [hash = '', short = '', subject = '', date = '', author = ''] = line.split('\x1f')
    return { hash, short, subject, date, author }
  })
}

function renderPatchHtml(raw: string): string {
  return raw.split('\n').map((line, index) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? ' tasks-diff-line-add'
      : line.startsWith('-') && !line.startsWith('---') ? ' tasks-diff-line-del'
        : line.startsWith('@@') ? ' tasks-diff-hunk' : ''
    return `<span class="tasks-diff-code-line${cls}"><span class="tasks-diff-line-no">${index + 1}</span>${escHtml(line)}</span>`
  }).join('')
}

function fileStateMap(raw: string): Map<string, string> {
  const states = new Map<string, string>()
  for (const line of raw.split('\n').filter(Boolean)) {
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ').at(-1) ?? path
    const state = x === '?' && y === '?' ? 'untracked'
      : x !== ' ' && y !== ' ' ? 'staged + modificado'
        : x !== ' ' ? 'staged' : 'sin stage'
    states.set(path.replace(/^"|"$/g, ''), state)
  }
  return states
}

function renderSourceHtml(raw: string): string {
  return raw.split('\n').map((line, index) => {
    const highlighted = escHtml(line).replace(
      /\b(const|let|var|function|class|interface|type|export|import|from|return|if|else|for|while|match|pub|fn|struct|impl|async|await|try|catch)\b/g,
      '<span class="tasks-source-keyword">$1</span>',
    )
    return `<span class="tasks-diff-code-line"><span class="tasks-diff-line-no">${index + 1}</span>${highlighted}</span>`
  }).join('')
}

// Builds a file list from `git diff-tree --name-status` output: "<M|A|D>\t<path>" lines.
// When loadPatch is provided, each file expands its code diff inline.
function buildFileList(
  raw: string,
  loadPatch?: (file: string) => Promise<string>,
  loadFullFile?: (file: string) => Promise<string>,
): HTMLElement[] {
  const STATUS_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', T: 'T' }
  const STATUS_CLASS: Record<string, string> = { M: 'fl-mod', A: 'fl-add', D: 'fl-del', R: 'fl-ren', C: 'fl-ren', T: 'fl-mod' }
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t')
    const statusCode = parts[0]?.trim()[0] ?? 'M'
    const paths = parts.slice(1)
    const filePath = paths.length > 1 ? paths.join(' → ') : paths[0] ?? line
    const targetPath = paths.at(-1) ?? filePath
    const entry = document.createElement('div')
    entry.className = 'tasks-commit-file-entry'
    const row = document.createElement(loadPatch ? 'button' : 'div')
    row.className = `tasks-commit-file-row${loadPatch ? ' tasks-commit-file-row--openable' : ''}`
    row.append(
      Object.assign(document.createElement('span'), { className: `tasks-file-status ${STATUS_CLASS[statusCode] ?? 'fl-mod'}`, textContent: STATUS_LABEL[statusCode] ?? statusCode }),
      Object.assign(document.createElement('span'), { className: 'tasks-file-path', textContent: filePath }),
    )
    entry.appendChild(row)

    if (loadPatch) {
      const patch = document.createElement('pre')
      patch.className = 'tasks-commit-file-diff hidden'
      let loaded = false
      row.title = taskT('changedCode')
      row.addEventListener('click', async () => {
        const opening = patch.classList.contains('hidden')
        patch.classList.toggle('hidden', !opening)
        row.classList.toggle('tasks-commit-file-row--expanded', opening)
        if (!opening || loaded) return
        patch.textContent = taskT('loadingCode')
        try {
          const diff = await loadPatch(targetPath)
          patch.innerHTML = diff.trim() ? renderPatchHtml(diff) : `<span>${taskT('noTextPatch')}</span>`
          loaded = true
        } catch (e) {
          patch.textContent = String(e)
        }
      })
      entry.appendChild(patch)
    }

    if (loadFullFile) {
      const fullBtn = Object.assign(document.createElement('button'), {
        className: 'tasks-file-full-btn',
        textContent: taskT('fullFile'),
        title: taskT('viewFullCommitFile'),
      })
      const full = document.createElement('pre')
      full.className = 'tasks-commit-file-diff tasks-full-file hidden'
      let fullLoaded = false
      fullBtn.addEventListener('click', async () => {
        const opening = full.classList.contains('hidden')
        full.classList.toggle('hidden', !opening)
        if (!opening || fullLoaded) return
        full.textContent = taskT('loadFile')
        try {
          const content = await loadFullFile(targetPath)
          full.innerHTML = renderSourceHtml(content)
          fullLoaded = true
        } catch (e) { full.textContent = String(e) }
      })
      entry.append(fullBtn, full)
    }

    return entry
  })
}

export function createTasksPanel(panelId = 'default'): { element: HTMLElement } {
  // Per-panel keys so multiple tasks panels can track different repos independently
  const REPO_KEY = `bento.tasks.repo.${panelId}`
  const SELECTED_KEY = `bento.tasks.selected.${panelId}`
  const BASE_KEY = `bento.tasks.base.${panelId}`
  const OPERATIONS_KEY = `bento.tasks.gitOperations.${panelId}`

  let worktrees: Worktree[] = []
  let repoPath = localStorage.getItem(REPO_KEY) ?? ''
  let detailCleanup: () => void = () => {}
  let selectedRow: HTMLElement | null = null
  let filterText = ''
  let lastStatuses = new Map<string, number>()
  let lastRunningPaths = new Set<string>()
  let baseBranch = localStorage.getItem(BASE_KEY) ?? 'main'
  let jiraCfg: JiraConfig | null = null
  let issueMap = new Map<string, TaskIssue | null>()
  let aheadBehindMap = new Map<string, { ahead: number; behind: number }>()
  let prStatusMap = new Map<string, PrStatus | null>()
  let backupStatusMap = new Map<string, BackupStatus>()
  let rebaseStatusMap = new Map<string, RebaseStatus>()
  let upstreamStatusMap = new Map<string, UpstreamStatus>()
  let fetchedAt = 0
  let diffRefreshInterval: ReturnType<typeof setInterval> | null = null

  const readOperations = (): GitOperationEntry[] => {
    try { return JSON.parse(localStorage.getItem(OPERATIONS_KEY) ?? '[]') as GitOperationEntry[] }
    catch { return [] }
  }
  const recordOperation = (wt: Worktree, operation: string, status: 'success' | 'error', detail: string): void => {
    const entries = appendOperation(readOperations(), {
      repository: repoPath,
      branch: wt.branch ?? '(detached)',
      operation,
      status,
      detail: detail.replace(/(?:token|password|authorization)\s*[:=]\s*\S+/gi, '$1=[oculto]').slice(0, 500),
    })
    localStorage.setItem(OPERATIONS_KEY, JSON.stringify(entries))
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
    repoBtn.innerHTML = `${icon('folder')}<span>${name}</span>`
  }
  updateRepoBtn()
  repoBtn.addEventListener('click', async () => {
    const picked = await pickFolder({ directory: true, defaultPath: repoPath || undefined }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    repoPath = picked
    localStorage.setItem(REPO_KEY, repoPath)
    localStorage.removeItem(BASE_KEY)
    updateRepoBtn()
    load()
  })
  const baseSelect = document.createElement('select')
  baseSelect.className = 'tasks-base-select'
  baseSelect.title = taskT('baseBranch')
  baseSelect.addEventListener('change', () => {
    baseBranch = baseSelect.value
    localStorage.setItem(BASE_KEY, baseBranch)
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
    if (isMain) branchEl.title = 'worktree principal'

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
      abEl.title = `${ab.ahead} / ${ab.behind} · origin/${baseBranch}`
    }

    // PR status badge
    const prEl = document.createElement('span')
    if (pr) {
      const stateMap: Record<string, string> = { OPEN: 'tasks-pr-open', DRAFT: 'tasks-pr-draft', MERGED: 'tasks-pr-merged', CLOSED: 'tasks-pr-closed' }
      const labelMap: Record<string, string> = { OPEN: 'PR', DRAFT: 'Draft PR', MERGED: 'Merged', CLOSED: 'PR cerrado' }
      prEl.className = `tasks-pr-badge ${stateMap[pr.state] ?? ''}`
      const checks = pr.statusCheckRollup ?? []
      const failedChecks = checks.filter(check => /FAIL|ERROR|CANCEL|TIMED_OUT/i.test(check.conclusion ?? check.state ?? ''))
      const pendingChecks = checks.filter(check => /PENDING|QUEUED|IN_PROGRESS|EXPECTED/i.test(check.status ?? check.state ?? ''))
      prEl.textContent = failedChecks.length ? taskT('failedChecks', { count: failedChecks.length })
        : pendingChecks.length ? `PR · ${pendingChecks.length} pendiente${pendingChecks.length > 1 ? 's' : ''}`
          : labelMap[pr.state] ?? 'PR'
      const prSignals = [
        pr.baseRefName ? `base: ${pr.baseRefName}` : '',
        pr.mergeable === 'CONFLICTING' ? 'conflictos con la base' : '',
        pr.reviewDecision === 'APPROVED' ? taskT('approved') : pr.reviewDecision === 'CHANGES_REQUESTED' ? taskT('changesRequested') : pr.reviewDecision === 'REVIEW_REQUIRED' ? taskT('reviewPending') : '',
        failedChecks.length ? `${failedChecks.length} check(s) fallando` : pendingChecks.length ? `${pendingChecks.length} check(s) pendientes` : checks.length ? 'checks correctos' : '',
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
      rebaseEl.textContent = rebase.total ? `rebase ${rebase.current ?? 0}/${rebase.total}` : taskT('pausedRebase')
      rebaseEl.title = 'Pulsa para recuperar el rebase activo'
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
        const status = await invoke<string>('git_status', { path: wt.path }).catch(() => '')
        const hasChanges = parseStatus(status).total > 0
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
      // eslint-disable-next-line no-alert
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
      const items = [
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
            localStorage.setItem(BASE_KEY, baseBranch)
            load()
          },
        })
      }
      if (!isMain) {
        items.push(
          { label: 'Docker', onClick: () => { selectRow(row); isolateDocker(wt) } },
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
          { label: taskT('backups'), onClick: () => { selectRow(row); showBackupHistory(wt) } },
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
      localStorage.setItem(SELECTED_KEY, wt.path)
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
        invoke<string>('git_status', { path: wt.path }).catch(() => ''),
        invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false })),
      ])
      const rebaseActive = rebaseStatus.active
      showDetail(buildDiffView(raw, wt, { statusRaw, rebaseActive }))
      // Auto-refresh: re-fetch diff every 5 s and update if content changed
      let lastSnapshot = `${statusRaw}\0${raw}`
      diffRefreshInterval = setInterval(async () => {
        const [newRaw, newStatus] = await Promise.all([
          invoke<string>('git_diff', { path: wt.path }).catch(() => null),
          invoke<string>('git_status', { path: wt.path }).catch(() => ''),
        ])
        const snapshot = `${newStatus}\0${newRaw ?? ''}`
        if (newRaw !== null && snapshot !== lastSnapshot) {
          lastSnapshot = snapshot
          showDetail(buildDiffView(newRaw, wt, { statusRaw: newStatus, rebaseActive }))
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
      textContent: 'Amend',
    })
    let doAmend = opts.initAmend ?? false
    amendToggle.classList.toggle('tasks-amend-btn--active', doAmend)
    if (doAmend) msgInput.placeholder = taskT('keepMessage')
    amendToggle.addEventListener('click', () => {
      doAmend = !doAmend
      amendToggle.classList.toggle('tasks-amend-btn--active', doAmend)
      msgInput.placeholder = doAmend ? taskT('keepMessage') : taskT('commitMessage')
      commitBtn.textContent = doAmend ? 'Amend commit' : 'Commit'
    })

    const commitBtn = Object.assign(document.createElement('button'), {
      className: 'tasks-commit-btn',
      textContent: 'Commit',
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
        commitBtn.textContent = 'Commit'
        const [newRaw, newStatus] = await Promise.all([
          invoke<string>('git_diff', { path: wt.path }),
          invoke<string>('git_status', { path: wt.path }).catch(() => ''),
        ])
        showDetail(buildDiffView(newRaw, wt, { statusRaw: newStatus, rebaseActive: opts.rebaseActive }))
        showCommitStatus(wasAmend ? '✓ Commit enmendado' : '✓ Commit creado')
        // Update sidebar badge and ahead/behind
        const s = await invoke<string>('git_status', { path: wt.path }).catch(() => '')
        lastStatuses.set(wt.path, parseStatus(s).total)
        const abRaw = await invoke<string>('git_ahead_behind', { path: wt.path, base: baseBranch }).catch(() => '')
        aheadBehindMap.set(wt.path, parseAheadBehind(abRaw))
        applyFilter()
      } catch (e) {
        recordOperation(wt, doAmend ? 'commit --amend' : 'commit', 'error', String(e))
        commitBtn.textContent = doAmend ? 'Amend commit' : 'Commit'
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
      const raw = await invoke<string>('git_rebase_log', { path: wt.path, base: baseBranch })
      const entries = parseLogEntries(raw)
      if (entries.length === 0) {
        showDetail(note(taskT('noOwnCommits', { base: baseBranch }), 'db-detail-hint'))
        return
      }

      const incomingFiles = new Set(files ?? diffFileNames(incomingDiff))
      const [recommendationRaw, blameRaw] = await Promise.all([
        invoke<string>('git_recommend_commits', {
          path: wt.path, base: baseBranch, files: [...incomingFiles],
        }).catch(() => ''),
        invoke<string>('git_blame_recommend', {
          path: wt.path, base: baseBranch, patch: incomingDiff,
        }).catch(() => ''),
      ])
      const historyScores = new Map<string, { score: number; files: string[] }>()
      for (const line of recommendationRaw.split('\n').filter(Boolean)) {
        const [hash = '', score = '0', paths = ''] = line.split('\x1f')
        historyScores.set(hash, { score: Number(score), files: paths.split(',').filter(Boolean) })
      }
      const blameScores = new Map<string, { score: number; files: string[] }>()
      for (const line of blameRaw.split('\n').filter(Boolean)) {
        const [hash = '', score = '0', paths = ''] = line.split('\x1f')
        blameScores.set(hash, { score: Number(score), files: paths.split(',').filter(Boolean) })
      }
      const enriched = await Promise.all(entries.map(async (entry, originalIndex) => {
        const filesRaw = await invoke<string>('git_show_files', { path: wt.path, hash: entry.hash }).catch(() => '')
        const overlap = matchingPaths(incomingFiles, changedPaths(filesRaw))
        const history = historyScores.get(entry.hash) ?? { score: 0, files: [] }
        const blame = blameScores.get(entry.hash) ?? { score: 0, files: [] }
        return { entry, filesRaw, overlap, history, blame, originalIndex }
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
      for (const { entry, filesRaw, overlap, history, blame } of enriched) {
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
          filesEl.replaceChildren(...buildFileList(
            filesRaw,
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
        onOperation: (status, detail) => recordOperation(wt, 'restaurar respaldo', status, detail),
      }))
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function showOperationHistory(wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    const branch = wt.branch ?? '(detached)'
    showDetail(buildOperationHistoryView({
      branch,
      repository: repoPath,
      entries: readOperations(),
      onBack: () => showChanges(wt),
      onClear: () => {
        localStorage.setItem(OPERATIONS_KEY, JSON.stringify(readOperations().filter(entry => entry.repository !== repoPath || entry.branch !== branch)))
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
      const raw = await invoke<string>('git_log', { path: wt.path, limit: 50, noMerges: false })
      const entries = parseLogEntries(raw)
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
          const raw = await invoke<string>('git_show_files', { path: wt.path, hash: e.hash }).catch(() => '')
          filesEl.replaceChildren(...buildFileList(
            raw,
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

      const [raw, mergeRaw] = await Promise.all([
        invoke<string>('git_rebase_log', { path: wt.path, base: baseBranch }),
        invoke<string>('git_merge_log', { path: wt.path, base: baseBranch }).catch(() => ''),
      ])
      const entries = parseLogEntries(raw)
      if (entries.length === 0) {
        showDetail(note(taskT('noOwnCommits', { base: baseBranch }), 'db-detail-hint'))
        return
      }
      const merges = parseLogEntries(mergeRaw)
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
        row.setAttribute('aria-label', `${item.action} ${item.short} ${item.subject}. Alt flecha arriba o abajo para mover.`)

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

        const upBtn = iconBtn('chevron-up', 'Subir', () => {
          if (idx === 0) return
          ;[items[idx - 1], items[idx]] = [items[idx], items[idx - 1]]
          renderList()
        })
        const downBtn = iconBtn('chevron-down', 'Bajar', () => {
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
          const raw = await invoke<string>('git_show_files', { path: wt.path, hash: item.hash }).catch(() => '')
          filesEl.replaceChildren(...buildFileList(
            raw,
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
        textContent: st.total ? `Rebase ${st.current ?? 0}/${st.total}:` : taskT('editing'),
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
            resolveBtn.title = 'Abrir resolver de conflictos en el panel'
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
      invoke<string>('git_status', { path: wt.path }).then(status => {
        const conflicts = parseConflictFiles(status)
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
            iconBtn('edit', 'Abrir en editor', () => {
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

  // ---- detail: docker ----
  async function isolateDocker(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    try {
      const result = await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: wt.path })
      buildDockerDetail(result, wt)
    } catch (e) {
      const msg = String(e)
      showDetail(note(msg === 'no-compose' ? taskT('noCompose') : msg,
        msg === 'no-compose' ? 'db-detail-hint' : 'db-detail-error'))
    }
  }

  function buildDockerDetail(result: IsolateResult, wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup()
    const worktreeDir = wt.path.replace(/\/$/, '').split('/').pop()!

    const wrap = document.createElement('div')
    wrap.className = 'tasks-docker-detail'

    const statusLabel = Object.assign(document.createElement('span'), { className: 'tasks-compose-status' })

    const upBtn = iconBtn('play', taskT('startStack'), async () => {
      upBtn.disabled = true; statusLabel.textContent = taskT('starting')
      await invoke('docker_compose_up', { worktreePath: wt.path }).catch(e => { statusLabel.textContent = String(e) })
      upBtn.disabled = false
      if (statusLabel.textContent === taskT('starting')) statusLabel.textContent = ''
    })
    const downBtn = iconBtn('stop', taskT('stopStack'), async () => {
      downBtn.disabled = true; statusLabel.textContent = taskT('stopping')
      await invoke('docker_compose_down', { worktreePath: wt.path }).catch(e => { statusLabel.textContent = String(e) })
      downBtn.disabled = false
      if (statusLabel.textContent === taskT('stopping')) statusLabel.textContent = ''
    })
    const stackLogsBtn = iconBtn('list', taskT('stackLogs'), () => showStackLogs(wt, worktreeDir))

    const controls = document.createElement('div')
    controls.className = 'tasks-compose-controls'
    controls.append(upBtn, downBtn, stackLogsBtn, statusLabel)
    wrap.appendChild(controls)

    if (result.urls.length > 0) {
      const urlList = document.createElement('div')
      urlList.className = 'tasks-url-list'
      for (const { service, url } of result.urls) {
        const a = Object.assign(document.createElement('a'), { className: 'tasks-url-link', href: '#', textContent: `${service} → ${url}` })
        a.addEventListener('click', e => { e.preventDefault(); openUrl(url).catch(() => {}) })
        urlList.appendChild(a)
      }
      wrap.appendChild(urlList)
    }

    const containerList = document.createElement('div')
    containerList.className = 'tasks-container-list'
    wrap.appendChild(containerList)

    const refresh = async (): Promise<void> => {
      const all = parseContainers(await invoke<string>('docker_list').catch(() => ''))
      const mine = all.filter(c => c.name.startsWith(`${worktreeDir}-`))
      containerList.replaceChildren()
      if (mine.length === 0) {
        containerList.appendChild(note(taskT('emptyContainers'), 'tasks-note'))
        return
      }
      for (const c of mine) {
        const shortName = c.name.slice(worktreeDir.length + 1)
        const running = isRunning(c)
        const row = document.createElement('div')
        row.className = 'tasks-ctr-row'
        const dot = Object.assign(document.createElement('span'), { className: `docker-dot ${running ? 'docker-up' : 'docker-down'}` })
        const lbl = Object.assign(document.createElement('span'), { className: 'tasks-ctr-name', textContent: shortName })
        const btns = document.createElement('div')
        btns.className = 'tasks-ctr-btns'
        const restartBtn = iconBtn(running ? 'power' : 'play', running ? taskT('restart') : taskT('start'), async () => {
          await invoke(running ? 'docker_restart' : 'docker_start', { id: c.name }).catch(() => {})
          refresh()
        })
        const logsBtn = iconBtn('list', 'Logs', () => showContainerLogs(c, shortName, () => buildDockerDetail(result, wt)))
        const termBtn = iconBtn('terminal', 'Terminal', () => showContainerTerminal(c, shortName, () => buildDockerDetail(result, wt)))
        logsBtn.disabled = !running; termBtn.disabled = !running
        btns.append(restartBtn, logsBtn, termBtn)
        row.append(dot, lbl, btns)
        containerList.appendChild(row)
      }
    }

    refresh()
    const interval = setInterval(refresh, 3000)
    detailCleanup = () => clearInterval(interval)
    showDetail(wrap)
  }

  // ---- stack logs ----
  function showStackLogs(wt: Worktree, worktreeDir: string): void {
    stopDiffRefresh()
    detailCleanup()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const logsBody = document.createElement('div')
    logsBody.className = 'tasks-logs-body'

    let rawLogs = '', live = false
    let unlisten: (() => void) | null = null
    const event = `docker-compose-logs-${worktreeDir}`
    const pre = document.createElement('pre')
    pre.className = 'docker-logs'

    const stopLive = (): void => {
      if (!live) return
      live = false
      liveBtn.innerHTML = icon('play'); liveBtn.title = 'Seguir logs en vivo'; liveBtn.classList.remove('active')
      invoke('docker_compose_logs_stop', { worktreePath: wt.path }).catch(() => {})
      unlisten?.(); unlisten = null
    }
    const startLive = async (): Promise<void> => {
      live = true
      liveBtn.innerHTML = icon('stop'); liveBtn.title = 'Parar el seguimiento'; liveBtn.classList.add('active')
      rawLogs = ''; pre.textContent = ''
      try {
        await invoke('docker_compose_logs_follow', { worktreePath: wt.path, tail: 200 })
        unlisten = await listen<string>(event, e => {
          rawLogs += e.payload; pre.textContent += e.payload; pre.scrollTop = pre.scrollHeight
        })
      } catch (e) { pre.textContent = String(e) }
    }

    const liveBtn = iconBtn('play', 'Seguir logs en vivo', () => live ? stopLive() : startLive())
    const refreshBtn = iconBtn('refresh', 'Recargar', () => {
      if (live) { stopLive(); startLive() } else {
        pre.textContent = taskT('loading')
        invoke<string>('docker_logs', { id: worktreeDir, tail: 500 }).catch(() => '').then(r => { rawLogs = r; pre.textContent = r || taskT('noLogs') })
      }
    })

    const head = document.createElement('div')
    head.className = 'docker-logs-head'
    head.append(Object.assign(document.createElement('span'), { textContent: 'Stack logs' }), liveBtn, refreshBtn)

    logsBody.append(head, pre)
    wrap.append(buildSubHead('Stack logs', () => buildDockerDetail({ subnet: '', urls: [] } as IsolateResult, wt)), logsBody)
    showDetail(wrap)
    detailCleanup = stopLive
    startLive()
  }

  // ---- container: logs ----
  function showContainerLogs(c: Container, shortName: string, goBack: () => void): void {
    stopDiffRefresh()
    detailCleanup()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const logsBody = document.createElement('div')
    logsBody.className = 'tasks-logs-body'
    wrap.append(buildSubHead(shortName, goBack), logsBody)
    showDetail(wrap)
    detailCleanup = renderContainerLogs(c, logsBody)
  }

  // ---- container: terminal ----
  async function showContainerTerminal(c: Container, shortName: string, goBack: () => void): Promise<void> {
    stopDiffRefresh()
    detailCleanup()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const termBody = document.createElement('div')
    termBody.className = 'tasks-term-body'
    wrap.append(buildSubHead(shortName, goBack), termBody)
    showDetail(wrap)
    detailCleanup = await renderContainerTerminal(c, termBody, goBack)
  }

  function buildSubHead(title: string, goBack: () => void, ...extra: HTMLElement[]): HTMLElement {
    const head = document.createElement('div')
    head.className = 'tasks-sub-head'
    head.append(iconBtn('arrow-left', taskT('back'), goBack), Object.assign(document.createElement('span'), { className: 'tasks-sub-title', textContent: title }), ...extra)
    return head
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
      if (result && wt) buildDockerDetail(result, wt)
    } catch (e) { listWrap.replaceChildren(note(String(e), 'db-detail-error')) }
  }

  async function deleteWorktree(wt: Worktree): Promise<void> {
    const { total } = parseStatus(await invoke<string>('git_status', { path: wt.path }).catch(() => ''))
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
      const [defaultBranch, remoteBranchesRaw] = await Promise.all([
        invoke<string>('git_default_branch', { repo: repoPath }).catch(() => 'main'),
        invoke<string>('git_remote_branches', { repo: repoPath }).catch(() => ''),
      ])
      const remoteBranches = remoteBranchesRaw.split('\n').filter(Boolean)
      if (!remoteBranches.includes(defaultBranch)) remoteBranches.unshift(defaultBranch)
      const savedBase = localStorage.getItem(BASE_KEY)
      baseBranch = savedBase && remoteBranches.includes(savedBase) ? savedBase : defaultBranch
      localStorage.setItem(BASE_KEY, baseBranch)
      baseSelect.replaceChildren(...remoteBranches.map(branch => Object.assign(document.createElement('option'), {
        value: branch,
        textContent: `base: ${branch}`,
        selected: branch === baseBranch,
      })))
      worktrees = parseWorktreeList(await invoke<string>('git_worktree_list', { repo: repoPath }))
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
          const s = await invoke<string>('git_status', { path: wt.path }).catch(() => '')
          return [wt.path, parseStatus(s).total] as [string, number]
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

        backupStatusMap.set(wt.path, await invoke<BackupStatus>('git_backup_status', { path: wt.path }).catch(() => ({ available: false })))

        rebaseStatusMap.set(wt.path, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false })))

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
      const savedPath = localStorage.getItem(SELECTED_KEY)
      const activeWt = worktrees.find(w => rebaseStatusMap.get(w.path)?.active)
      const selectedWt = activeWt ?? (savedPath ? worktrees.find(w => w.path === savedPath) : undefined)
      if (selectedWt) {
        const rows = listWrap.querySelectorAll<HTMLElement>('.tasks-row')
        const idx = worktrees.indexOf(selectedWt)
        if (rows[idx]) {
          selectRow(rows[idx])
          localStorage.setItem(SELECTED_KEY, selectedWt.path)
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
