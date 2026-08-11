import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { open as pickFolder, confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import { taskBranch, taskPath, type Worktree } from '../../core/git/worktree'
import { showContextMenu } from '../../ui/contextMenu'
import { icon } from '../../ui/icons'
import { extractIssueKey, statusCategoryClass, parseAheadBehind } from '../../core/git/taskJira'
import { diffFileNames, changedPaths, matchingPaths, buildSelectedPatch } from '../../core/git/commitWorkflow'
import { previewRebase, type RebaseAction, type RebasePlanItem } from '../../core/git/rebaseWorkflow'
import {
  fetchIssue, fetchTransitions, applyTransition, browseUrl, loadJiraConfig,
  type JiraConfig, type TaskIssue,
} from './taskJiraClient'
import { buildOperationHistoryView } from './OperationHistoryView'
import type { BackupStatus, CommitEntry, PrStatus, RebaseStatus, RewritePreflight, UpstreamStatus } from './gitTypes'
import { buildPrStatusView } from './PrStatusView'
import { taskT } from './i18n'
import { buildBackupHistoryView } from './BackupHistoryView'
import { buildConflictResolverView } from './ConflictResolverView'
import { buildChangesFileView } from './ChangesFileView'
import { buildRebasePlanPreview } from './RebasePlanView'
import { buildCommitFileList, fileStateMap, renderPatchHtml } from './TaskCodeView'
import { commitFilesRaw, recommendationMap, taskGit } from './taskGitClient'
import { TaskPanelStore } from './TaskPanelStore'
import { createTaskDockerView, type IsolateResult, type RecipeApplyResult } from './TaskDockerView'
import { buildResetView } from './ResetView'
import { buildGraphView } from './GraphView'
import { buildCommitLogView } from './CommitLogView'
import { buildRebaseMergeWarning } from './RebaseMergeWarningView'
import { buildSyncErrorView } from './TaskAuxiliaryViews'
import { loadTaskData } from './TaskDataLoader'
import { taskProgress } from './taskProgress'
import { buildIncomingChangesView } from './IncomingChangesView'
import { taskRowActions } from './TaskRowActions'
import { TauriAppSettingsRepository } from '../../adapters/TauriAppSettingsRepository'
import type { AppSettings } from '../../ports/AppSettingsRepository'
import { isRunning, parseContainers } from '../../core/docker/containers'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'

export function createTasksPanel(panelId = 'default'): { element: HTMLElement; dispose: () => void } {
  const panelStore = new TaskPanelStore(panelId)
  const settingsRepository = new TauriAppSettingsRepository()
  let appSettings: AppSettings = {}
  const settingsReady = settingsRepository.load().then(settings => { appSettings = settings }).catch(() => {})
  let worktrees: Worktree[] = []
  let repoPath = panelStore.repository()
  let detailCleanup: () => void = () => {}
  // Live agents hub per worktree. Kept alive across detail navigation so the
  // running agents/terminals survive switching to changes/history and back;
  // disposed only when the worktree is removed or the whole panel closes.
  const worktreeTerminals = new Map<string, { element: HTMLElement; fit: () => void; persist: () => void; dispose: () => void }>()
  let selectedRow: HTMLElement | null = null
  let selectedWorktreePath = panelStore.selected() ?? ''
  let selectedRepositoryPath = repoPath
  let selectionVersion = 0
  let detailVersion = 0
  let filterText = ''
  // Multi-repo: which repo each worktree belongs to, and per-repo collapse state.
  const repoOf = new Map<string, string>()
  const baseOf = new Map<string, string>()
  const collapsedRepos = new Set<string>()
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
  let diffRefreshInterval: ReturnType<typeof setInterval> | null = null

  const repositoryFor = (wt: Worktree): string => repoOf.get(wt.path) ?? repoPath
  const baseFor = (wt: Worktree): string => baseOf.get(wt.path) ?? baseBranch

  const recordOperation = (wt: Worktree, operation: string, status: 'success' | 'error', detail: string): void => {
    panelStore.recordOperation(repositoryFor(wt), wt.branch ?? '(detached)', operation, status, detail)
  }

  const selectRow = (row: HTMLElement): void => {
    selectedRow?.classList.remove('tasks-row--selected')
    selectedRow = row
    row.classList.add('tasks-row--selected')
  }

  const selectedRepository = (): string => selectedRepositoryPath || repoPath

  // Populated after cs is created; called on every selection/list change.
  let refreshMiniItems: () => void = () => {}

  const selectWorktree = (row: HTMLElement, wt: Worktree): number => {
    selectRow(row)
    selectedWorktreePath = wt.path
    selectedRepositoryPath = repositoryFor(wt)
    panelStore.setSelected(wt.path)
    selectionVersion += 1
    detailVersion += 1
    refreshMiniItems()
    return selectionVersion
  }

  const isCurrentSelection = (version: number, wt: Worktree): boolean => {
    const isSameSelectionVersion = version === selectionVersion
    return isSameSelectionVersion && selectedWorktreePath === wt.path
  }

  const stopDiffRefresh = (): void => {
    if (diffRefreshInterval !== null) { clearInterval(diffRefreshInterval); diffRefreshInterval = null }
  }

  const root = document.createElement('div')
  root.className = 'tasks-panel'
  root.dataset.testid = 'tasks-panel'
  root.dataset.panelId = panelId

  // ---- controls (mounted inside the left sidebar; no top header bar) ----
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
    // Add to the repo list (multi-repo). First pick behaves as before (one repo).
    panelStore.addRepository(picked)
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
  const refreshBtn = iconBtn('refresh', taskT('reload'), () => load())
  const settingsBtn = iconBtn('settings', taskT('taskSettings'), () => { void showTaskSettings() })
  settingsBtn.dataset.testid = 'tasks-settings'

  // ---- layout ----
  const body = document.createElement('div')
  body.className = 'tasks-body'

  const cs = createCollapsibleSidebar({
    storageKey: `bento.tasks.${panelId}.sidebar`,
    title: taskT('tasks'),
    defaultWidth: 260,
    minWidth: 180,
    minRemaining: 280,
    container: body,
  })
  // Make cs.list a flex column so filterInput stays fixed and listWrap scrolls
  Object.assign(cs.list.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column' })

  const filterInput = Object.assign(document.createElement('input'), {
    className: 'tasks-filter-input',
    type: 'search',
    placeholder: taskT('filter'),
  })
  filterInput.addEventListener('input', () => { filterText = filterInput.value; applyFilter() })

  const listWrap = document.createElement('div')
  listWrap.className = 'tasks-list-wrap'
  let dragStartX = 0
  let dragStartY = 0
  let dragScrollLeft = 0
  let dragScrollTop = 0
  let didDragList = false
  let dragPointerId: number | null = null
  listWrap.addEventListener('pointerdown', e => {
    const target = e.target as HTMLElement
    const isInteractiveTarget = !!target.closest('button,input,select,textarea,a')
    if (isInteractiveTarget || e.button !== 0) return
    didDragList = false
    dragPointerId = e.pointerId
    dragStartX = e.clientX
    dragStartY = e.clientY
    dragScrollLeft = listWrap.scrollLeft
    dragScrollTop = listWrap.scrollTop
  })
  listWrap.addEventListener('pointermove', e => {
    if (dragPointerId !== e.pointerId) return
    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY
    const hasDraggedEnough = Math.abs(dx) > 3 || Math.abs(dy) > 3
    if (!hasDraggedEnough) return
    if (!listWrap.hasPointerCapture(e.pointerId)) listWrap.setPointerCapture(e.pointerId)
    didDragList = true
    listWrap.classList.add('tasks-list-wrap--dragging')
    listWrap.scrollLeft = dragScrollLeft - dx
    listWrap.scrollTop = dragScrollTop - dy
  })
  listWrap.addEventListener('pointerup', e => {
    if (listWrap.hasPointerCapture(e.pointerId)) listWrap.releasePointerCapture(e.pointerId)
    if (dragPointerId === e.pointerId) dragPointerId = null
    listWrap.classList.remove('tasks-list-wrap--dragging')
  })
  listWrap.addEventListener('pointercancel', e => {
    if (listWrap.hasPointerCapture(e.pointerId)) listWrap.releasePointerCapture(e.pointerId)
    if (dragPointerId === e.pointerId) dragPointerId = null
    listWrap.classList.remove('tasks-list-wrap--dragging')
  })
  listWrap.addEventListener('click', e => {
    if (!didDragList) return
    didDragList = false
    e.preventDefault()
    e.stopPropagation()
  }, true)

  const progressFooter = document.createElement('div')
  progressFooter.className = 'tasks-progress'

  // Persistent host for the single create form (rebuilt on repo-list changes).
  const createFormWrap = document.createElement('div')

  // Remove the principal repo from Bento (list only — never touches the repo on
  // disk or its worktrees).
  const removeRepoBtn = iconBtn('x', taskT('removeRepo'), () => {
    if (!repoPath) return
    panelStore.removeRepository(repoPath)
    load()
  })
  removeRepoBtn.classList.add('tasks-repo-remove')
  const repoRow = document.createElement('div')
  repoRow.className = 'tasks-repo-row'
  repoRow.append(repoBtn, removeRepoBtn)

  // Base branch + last-fetch age live below the repo row.
  const baseRow = document.createElement('div')
  baseRow.className = 'tasks-base-row'
  baseRow.append(baseSelect, fetchAgeEl)

  // Header actions (settings · refresh) go in the sidebar header, by the toggle.
  cs.actions.append(settingsBtn, refreshBtn)

  cs.list.append(filterInput, listWrap)
  // Bottom zone: repo selector + base branch + new-task form + progress.
  cs.footer.append(repoRow, baseRow, createFormWrap, progressFooter)

  const detailPane = document.createElement('div')
  detailPane.className = 'tasks-detail'
  body.append(cs.element, cs.resizer, detailPane)
  root.append(body)

  refreshMiniItems = (): void => {
    cs.setMiniItems(worktrees.map(wt => {
      const changes = lastStatuses.get(wt.path) ?? 0
      const hasRunning = lastRunningPaths.has(wt.path)
      return {
        label: wt.branch ?? wt.path.replace(/\/$/, '').split('/').pop() ?? wt.path,
        dot: hasRunning ? 'working' : changes > 0 ? 'blocked' : undefined,
        active: wt.path === selectedWorktreePath,
        onClick: () => listWrap.querySelector<HTMLElement>(`[data-path="${CSS.escape(wt.path)}"]`)?.click(),
      }
    }))
  }

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

  const defaultProjectKey = (repository = repoPath): string => repository.replace(/\/$/, '').split('/').pop() ?? ''
  const projectKey = (repository = repoPath): string => panelStore.projectKey() || defaultProjectKey(repository)

  const prepareTaskDevcontainer = async (worktree: Worktree): Promise<boolean> => {
    await settingsReady
    appSettings = await settingsRepository.load().catch(() => appSettings)
    return dockerView.prepareDevcontainer(
      worktree,
      appSettings.devcontainerRecipesDir,
      projectKey(repositoryFor(worktree)),
      panelStore.devcontainerDir() ?? undefined,
      path => panelStore.setDevcontainerDir(path),
    )
  }

  async function showTaskSettings(): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loading'), 'db-detail-loading'))
    await settingsReady

    const wrap = document.createElement('div')
    wrap.className = 'tasks-settings-view'
    const title = Object.assign(document.createElement('h3'), { textContent: taskT('taskSettings') })
    const description = note(taskT('recipesDirHint'), 'db-detail-hint')
    const recipeProject = projectKey() || taskT('recipesExampleProject')
    const projectGuide = note(taskT('addProjectRecipeHint', { project: recipeProject }), 'db-detail-hint')
    const recipeExample = Object.assign(document.createElement('pre'), {
      className: 'tasks-settings-example',
      textContent: `${appSettings.devcontainerRecipesDir || '/ruta/a/bento-recipes'}/${recipeProject}/\n`+
        '├── .env\n' +
        '└── .devcontainer/\n' +
        '    ├── docker-compose.override.yml\n' +
        '    └── bento-postcreate.sh',
    })
    const label = Object.assign(document.createElement('label'), {
      className: 'tasks-settings-label',
      textContent: taskT('recipesDir'),
    })
    const row = document.createElement('div')
    row.className = 'tasks-settings-row'
    const input = Object.assign(document.createElement('input'), {
      className: 'tasks-settings-input',
      type: 'text',
      readOnly: true,
      placeholder: taskT('recipesDirEmpty'),
      value: appSettings.devcontainerRecipesDir ?? '',
    })
    const status = note('', 'tasks-note')

    const keyLabel = Object.assign(document.createElement('label'), {
      className: 'tasks-settings-label',
      textContent: taskT('projectKey'),
    })
    const keyInput = Object.assign(document.createElement('input'), {
      className: 'tasks-settings-input',
      type: 'text',
      value: projectKey(),
      placeholder: defaultProjectKey(),
    })
    keyInput.addEventListener('change', () => {
      panelStore.setProjectKey(keyInput.value === defaultProjectKey() ? '' : keyInput.value)
      void showTaskSettings()
    })
    keyLabel.appendChild(keyInput)

    const persist = async (directory: string | undefined): Promise<void> => {
      appSettings = { ...appSettings, devcontainerRecipesDir: directory || undefined }
      input.value = directory ?? ''
      status.textContent = taskT('savingSettings')
      try {
        await settingsRepository.save(appSettings)
        status.textContent = taskT('settingsSaved')
      } catch (error) {
        status.className = 'db-detail-error'
        status.textContent = String(error)
      }
    }
    const choose = iconBtn('folder', taskT('chooseRecipesDir'), () => {
      void pickFolder({
        directory: true,
        defaultPath: appSettings.devcontainerRecipesDir,
      }).then(picked => {
        if (typeof picked === 'string') void persist(picked)
      }).catch(() => {})
    })
    const clear = iconBtn('x', taskT('clearRecipesDir'), () => { void persist(undefined) })
    input.addEventListener('click', () => choose.click())
    row.append(input, choose, clear)
    label.append(row)

    const recipeActions = document.createElement('div')
    recipeActions.className = 'tasks-compose-controls'
    const recipePath = (): string | null => appSettings.devcontainerRecipesDir
      ? `${appSettings.devcontainerRecipesDir.replace(/\/$/, '')}/${projectKey()}`
      : null
    const createRecipe = iconBtn('plus', taskT('createRecipe'), () => {
      if (!appSettings.devcontainerRecipesDir) { status.textContent = taskT('selectRecipesDirFirst'); return }
      void invoke<string>('devcontainer_recipe_create', {
        recipesDir: appSettings.devcontainerRecipesDir,
        projectKey: projectKey(),
      }).then(path => {
        status.className = 'tasks-note'
        status.textContent = taskT('recipeCreated', { path })
      }).catch(error => { status.className = 'db-detail-error'; status.textContent = String(error) })
    })
    const openRecipe = iconBtn('folder', taskT('openRecipeFolder'), () => {
      const path = recipePath()
      if (path) invoke('open_in_editor', { path }).catch(error => { status.textContent = String(error) })
    })
    const gitAction = (action: 'init' | 'status' | 'pull' | 'push' | 'commit'): void => {
      if (!appSettings.devcontainerRecipesDir) { status.textContent = taskT('selectRecipesDirFirst'); return }
      const message = action === 'commit' ? window.prompt(taskT('recipeCommitMessage')) : null
      if (action === 'commit' && !message) return
      status.className = 'tasks-note'
      status.textContent = taskT('recipeGitRunning', { action })
      void invoke<string>('devcontainer_recipe_git', {
        recipesDir: appSettings.devcontainerRecipesDir,
        action,
        message,
      }).then(output => {
        status.textContent = output || taskT('recipeGitDone', { action })
      }).catch(error => { status.className = 'db-detail-error'; status.textContent = String(error) })
    }
    recipeActions.append(
      createRecipe,
      openRecipe,
      iconBtn('git-branch', taskT('initRecipesGit'), () => gitAction('init')),
      iconBtn('list', taskT('recipeGitStatus'), () => gitAction('status')),
      iconBtn('download', taskT('recipeGitPull'), () => gitAction('pull')),
      iconBtn('arrow-right', taskT('recipeGitPush'), () => gitAction('push')),
      iconBtn('check', taskT('recipeGitCommit'), () => gitAction('commit')),
    )
    wrap.append(title, description, projectGuide, recipeExample, keyLabel, label, recipeActions, status)
    showDetail(wrap)
  }

  showDetail(note(taskT('selectTask'), 'db-detail-hint'))

  // ---- list ----
  function renderList(statuses: Map<string, number>, runningPaths: Set<string>): void {
    lastStatuses = statuses
    lastRunningPaths = runningPaths
    applyFilter()
  }

  function progressBar(label: string, v: { done: number; total: number }): HTMLElement {
    const pct = v.total ? Math.round((v.done / v.total) * 100) : 0
    const wrap = document.createElement('div')
    wrap.className = 'tasks-progress-item'
    const head = document.createElement('div')
    head.className = 'tasks-progress-head'
    head.append(
      Object.assign(document.createElement('span'), { className: 'tasks-progress-label', textContent: label }),
      Object.assign(document.createElement('span'), { className: 'tasks-progress-stat', textContent: `${v.done}/${v.total} · ${pct}%` }),
    )
    const track = document.createElement('div')
    track.className = 'tasks-progress-track'
    const fill = document.createElement('div')
    fill.className = 'tasks-progress-fill'
    fill.style.width = `${pct}%`
    track.appendChild(fill)
    wrap.append(head, track)
    return wrap
  }

  // Footer progress bars: aggregate health of the repo's worktrees (see taskProgress).
  function updateProgress(): void {
    const p = taskProgress(worktrees, lastStatuses, aheadBehindMap)
    progressFooter.replaceChildren(
      progressBar(taskT('tasksClean'), p.clean),
      progressBar(taskT('tasksSynced'), p.synced),
    )
  }

  function applyFilter(): void {
    updateProgress()
    const lf = filterText.toLowerCase()
    const filtered = filterText
      ? worktrees.filter(wt => (wt.branch ?? '').toLowerCase().includes(lf) || wt.path.toLowerCase().includes(lf))
      : worktrees

    listWrap.replaceChildren()
    refreshCreateForm()
    if (filtered.length === 0) {
      listWrap.append(note(worktrees.length === 0 ? taskT('noWorktrees') : taskT('noResults')))
      refreshMiniItems()
      return
    }

    // Group worktrees by their repo (single repo → one group), preserving order.
    const byRepo = new Map<string, Worktree[]>()
    for (const wt of filtered) {
      const repo = repoOf.get(wt.path) ?? repoPath
      const bucket = byRepo.get(repo) ?? []
      bucket.push(wt)
      byRepo.set(repo, bucket)
    }
    for (const [repo, wts] of byRepo) listWrap.appendChild(buildProjectGroup(repo, wts))
    refreshMiniItems()
  }

  // Collapsible project header (repo name + count) grouping that repo's worktrees.
  function buildProjectGroup(repo: string, wts: Worktree[]): HTMLElement {
    const repoRoot = repo.replace(/\/$/, '')
    const group = document.createElement('div')
    group.className = `tasks-project${collapsedRepos.has(repo) ? ' collapsed' : ''}`
    const header = document.createElement('div')
    header.className = 'tasks-project-header'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'tasks-project-toggle'
    toggle.setAttribute('aria-expanded', String(!collapsedRepos.has(repo)))
    const chevron = document.createElement('span')
    chevron.className = 'tasks-project-chevron'
    chevron.innerHTML = icon('chevron-down')
    toggle.append(
      chevron,
      Object.assign(document.createElement('span'), { className: 'tasks-project-name', textContent: repoRoot.split('/').pop() ?? repo }),
      Object.assign(document.createElement('span'), { className: 'tasks-project-count', textContent: String(wts.length) }),
    )
    header.appendChild(toggle)
    // Remove this repo from the list (only offered when there's more than one).
    if (panelStore.repositories().length > 1) {
      const remove = Object.assign(document.createElement('button'), {
        type: 'button', className: 'tasks-project-remove', textContent: '×', title: taskT('removeRepo'),
      })
      remove.addEventListener('click', e => { e.stopPropagation(); panelStore.removeRepository(repo); load() })
      header.appendChild(remove)
    }
    toggle.addEventListener('click', () => {
      selectedRepositoryPath = repo
      if (collapsedRepos.has(repo)) collapsedRepos.delete(repo); else collapsedRepos.add(repo)
      group.classList.toggle('collapsed')
      toggle.setAttribute('aria-expanded', String(!collapsedRepos.has(repo)))
    })
    const list = document.createElement('div')
    list.className = 'tasks-list'
    wts.forEach(wt => {
      const isMain = wt.path.replace(/\/$/, '') === repoRoot
      list.appendChild(buildRow(wt, isMain, lastStatuses.get(wt.path) ?? 0, lastRunningPaths.has(wt.path)))
    })
    group.append(header, list)
    return group
  }

  function buildRow(wt: Worktree, isMain: boolean, changes: number, hasRunning: boolean): HTMLElement {
    const worktreeBase = baseFor(wt)
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
    const recipeEl = document.createElement('span')
    if (!isMain) {
      void invoke<RecipeApplyResult | null>('devcontainer_recipe_status', {
        worktreePath: wt.path,
        devcontainerDir: panelStore.devcontainerDir(),
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
        const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: worktreeBase }).catch(() => null)
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
        const out = await invoke<string>('git_sync', { path: wt.path, base: worktreeBase, mode, autostash })
        recordOperation(wt, mode, 'success', `origin/${worktreeBase}${out.trim() ? ` · ${out.trim()}` : ''}`)
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
        recordOperation(wt, taskT('restoringBackup'), 'success', backup.short ?? '')
        flashBadge(taskT('restoredHistory'), 'tasks-badge--ok', 3500)
        await load()
        showChanges(wt)
      } catch (e) {
        recordOperation(wt, taskT('restoringBackup'), 'error', String(e))
        selectRow(row)
        showSyncError(taskT('restoringBackup'), String(e), wt)
      }
    }

    const createPR = async (): Promise<void> => {
      flashBadge(taskT('creatingPr'), '', 60000)
      try {
        const result = await invoke<string>('git_create_pr', { path: wt.path, base: worktreeBase })
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

    const menuItems = () => taskRowActions({
      worktree: wt, row, isMain, baseBranch: worktreeBase, ahead, hasPr, issue: !!issue, jiraConfigured: !!jiraCfg, pr, backup, rebase,
      selectRow, showRebasePaused, showChanges, showHistory: showCommitLog, showGraph: showCommitGraph,
      showInteractiveRebase, showTerminal: showWorktreeTerminal, showPrDetails, showReset: showResetView,
      showBackups: showBackupHistory, showOperations: showOperationHistory,
      isolateDocker: wt => { void dockerView.isolate(wt) },
      prepareDevcontainer: wt => { if (repoPath) void prepareTaskDevcontainer(wt).then(ok => { if (!ok) showDetail(note(taskT('noDevcontainer'), 'db-detail-hint')) }) },
      runSync, copyBranch, openJira: openInJira,
      changeJiraStatus, push: pushBranch, createPr: createPR, restoreBackup, rename: renameTask,
      deleteTask: () => deleteWorktree(wt), setBase: branch => { baseBranch = branch; panelStore.setBase(branch) }, reload: load,
    })

    const menuBtn = iconBtn('more', taskT('actions'), () => {
      const r = menuBtn.getBoundingClientRect()
      showContextMenu(r.right - 4, r.bottom, menuItems())
    })
    menuBtn.dataset.testid = 'tasks-actions'
    const actions = document.createElement('div')
    actions.className = 'tasks-actions'
    actions.appendChild(menuBtn)

    row.addEventListener('click', async () => {
      const version = selectWorktree(row, wt)
      if (rebase?.active) { showRebasePaused(wt, rebase); return }
      // Devcontainer tasks show their URLs (cheap read); anything else shows the diff.
      const hasDevcontainerUrls = !isMain && await dockerView.showDevcontainerUrls(wt, panelStore.devcontainerDir() ?? undefined, () => isCurrentSelection(version, wt))
      if (!isCurrentSelection(version, wt)) return
      if (hasDevcontainerUrls) return
      showChanges(wt)
    })
    row.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault(); row.click()
    })
    row.addEventListener('contextmenu', e => {
      e.preventDefault()
      selectWorktree(row, wt)
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
  function buildCreateForm(): HTMLElement {
    const form = document.createElement('div')
    form.className = 'tasks-create'
    const repos = panelStore.repositories()

    let repoSelect: HTMLSelectElement | undefined
    if (repos.length > 1) {
      repoSelect = document.createElement('select')
      repoSelect.className = 'tasks-create-repo'
      repoSelect.title = taskT('selectRepo')
      for (const repo of repos) {
        repoSelect.appendChild(Object.assign(document.createElement('option'), {
          value: repo,
          textContent: repo.replace(/\/$/, '').split('/').pop() ?? repo,
          selected: repo === selectedRepository(),
        }))
      }
      repoSelect.addEventListener('change', () => { selectedRepositoryPath = repoSelect!.value })
    }

    const input = Object.assign(document.createElement('input'), { className: 'tasks-name-input', type: 'text', placeholder: taskT('newTask') })
    const submit = (): void => { void createTask(input.value.trim(), repoSelect?.value || selectedRepository()) }
    const btn = iconBtn('plus', taskT('createTask'), submit)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit() })

    if (repoSelect) form.append(repoSelect, input, btn)
    else form.append(input, btn)
    return form
  }

  // Rebuilds the footer create form so its repo selector reflects the current
  // repo list. Called from load()/applyFilter after the repo set may change.
  function refreshCreateForm(): void {
    createFormWrap.replaceChildren(panelStore.repositories().length > 0 ? buildCreateForm() : document.createDocumentFragment())
  }

  // ---- detail: changes (GitHub-style diff + commit bar) ----
  async function showChanges(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    const requestVersion = ++detailVersion
    showDetail(note(taskT('loadingChanges'), 'db-detail-loading'))
    try {
      const [raw, statusRaw, rebaseStatus] = await Promise.all([
        invoke<string>('git_diff', { path: wt.path }),
        taskGit.safeStatus(wt.path),
        invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false })),
      ])
      if (requestVersion !== detailVersion) return
      const rebaseActive = rebaseStatus.active
      showDetail(buildDiffView(raw, wt, { statusRaw: statusRaw.raw, rebaseActive }))
      // Auto-refresh: re-fetch diff every 5 s and update if content changed
      let lastSnapshot = `${statusRaw.raw}\0${raw}`
      diffRefreshInterval = setInterval(async () => {
        const [newRaw, newStatus] = await Promise.all([
          invoke<string>('git_diff', { path: wt.path }).catch(() => null),
          taskGit.safeStatus(wt.path),
        ])
        if (requestVersion !== detailVersion) return
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
        const abRaw = await invoke<string>('git_ahead_behind', { path: wt.path, base: baseFor(wt) }).catch(() => '')
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

  // ---- detail: choose an existing commit for fixup ----
  async function showFixupPicker(wt: Worktree, files: string[] | undefined, incomingDiff: string, selectedPatch?: string): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(note(taskT('loadingCommits'), 'db-detail-loading'))
    try {
      const worktreeBase = baseFor(wt)
      const entries = await taskGit.rebaseLog(wt.path, worktreeBase)
      if (entries.length === 0) {
        showDetail(note(taskT('noOwnCommits', { base: worktreeBase }), 'db-detail-hint'))
        return
      }

      const incomingFiles = new Set(files ?? diffFileNames(incomingDiff))
      const [recommendations, blameRecommendations] = await Promise.all([
        taskGit.recommendations(wt.path, worktreeBase, [...incomingFiles]).catch(() => []),
        taskGit.blameRecommendations(wt.path, worktreeBase, incomingDiff).catch(() => []),
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
      wrap.appendChild(buildIncomingChangesView(incomingDiff, files, note))

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
          const preflight = await invoke<RewritePreflight | null>('git_rewrite_preflight', { path: wt.path, base: worktreeBase }).catch(() => null)
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
            const result = await invoke<string>('git_fixup', { path: wt.path, target: entry.hash, base: worktreeBase, files, patch: selectedPatch })
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
    const repository = repositoryFor(wt)
    showDetail(buildOperationHistoryView({
      branch,
      repository,
      entries: panelStore.operations(),
      onBack: () => showChanges(wt),
      onClear: () => {
        panelStore.clearOperations(repository, branch)
        showOperationHistory(wt)
      },
    }))
  }

  // ---- detail: reset commits ----
  function showResetView(wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(buildResetView({
      worktree: wt,
      baseBranch: baseFor(wt),
      buildSubHead,
      onBack: () => showChanges(wt),
      onComplete: () => { showChanges(wt); load() },
      recordOperation: (operation, status, detail) => recordOperation(wt, operation, status, detail),
    }))
  }

  // ---- detail: commit log ----
  async function showCommitGraph(wt: Worktree): Promise<void> {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    await buildGraphView({
      worktree: wt,
      baseBranch: baseFor(wt),
      buildSubHead,
      onBack: () => showChanges(wt),
      showDetail,
      note,
    })
  }

  function showPrDetails(wt: Worktree, pr: PrStatus): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    showDetail(buildPrStatusView({
      pr, baseBranch: baseFor(wt),
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
      buildCommitLogView({
        worktree: wt,
        entries,
        buildSubHead,
        onBack: () => showChanges(wt),
        showDetail,
        note,
        iconBtn,
        buildCommitFileList,
        loadFiles: (path, hash) => taskGit.files(path, hash).catch(() => []),
      })
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

      const worktreeBase = baseFor(wt)
      const [entries, merges] = await Promise.all([
        taskGit.rebaseLog(wt.path, worktreeBase),
        taskGit.mergeLog(wt.path, worktreeBase).catch(() => []),
      ])
      if (entries.length === 0) {
        showDetail(note(taskT('noOwnCommits', { base: worktreeBase }), 'db-detail-hint'))
        return
      }
      if (merges.length) showMergeRebaseWarning(wt, entries, merges)
      else showRebaseEditor(wt, entries)
    } catch (e) { showDetail(note(String(e), 'db-detail-error')) }
  }

  function showMergeRebaseWarning(wt: Worktree, entries: CommitEntry[], merges: CommitEntry[]): void {
    buildRebaseMergeWarning({
      worktree: wt,
      baseBranch: baseFor(wt),
      entries,
      merges,
      buildSubHead,
      onBack: () => showChanges(wt),
      showDetail,
      showRebaseEditor,
      showRebasePaused,
      recordOperation: (operation, status, detail) => recordOperation(wt, operation, status, detail),
      onComplete: () => { showChanges(wt); load() },
    })
  }

  function showRebaseEditor(wt: Worktree, entries: CommitEntry[]): void {
    type RebaseItem = RebasePlanItem & { action: RebaseAction; newMessage: string }
    const items: RebaseItem[] = entries.map(e => ({ action: 'pick', hash: e.hash, short: e.short, subject: e.subject, newMessage: '' }))
    const ACTIONS: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']
    let draggedIndex: number | null = null
    let dragTarget: { index: number; after: boolean } | null = null

    const wrap = document.createElement('div')
    wrap.className = 'tasks-rebase-wrap'
    wrap.append(buildSubHead(taskT('interactiveTitle', { branch: wt.branch ?? '', base: baseFor(wt) }), () => showChanges(wt)))

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
        preflight = await invoke<RewritePreflight>('git_rewrite_preflight', { path: wt.path, base: baseFor(wt) })
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
        await invoke('git_rebase_start', { path: wt.path, base: baseFor(wt), todoLines })
        recordOperation(wt, 'rebase interactivo', 'success', `${items.length} instrucciones sobre origin/${baseFor(wt)}`)
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
    const { createAgentsPanel } = await import('../agents/AgentsPanel')
    // Reuse the live hub for this worktree if we already opened it; otherwise
    // create one scoped to the worktree (own storage, off the global dock).
    let panel = worktreeTerminals.get(wt.path)
    if (!panel) {
      panel = createAgentsPanel(wt.path, { storageScope: `bento.agents.wt:${wt.path}`, publishToDock: false })
      worktreeTerminals.set(wt.path, panel)
    }
    const wrap = document.createElement('div')
    wrap.className = 'tasks-term-wrap'
    const termBody = document.createElement('div')
    termBody.className = 'tasks-term-body'
    termBody.appendChild(panel.element)
    wrap.append(buildSubHead(`Terminal · ${wt.branch ?? ''}`, () => showChanges(wt)), termBody)
    showDetail(wrap)
    requestAnimationFrame(() => panel.fit())
    // Navigating away only detaches the element (showDetail replaces it); the
    // hub stays alive in the cache, so the agents keep running. Persist on leave
    // so they're restorable even if the tab closes without a clean dispose.
    const livePanel = panel
    detailCleanup = () => livePanel.persist()
  }

  // ---- detail: git sync error (with conflict detection + AI explain) ----
  function showSyncError(mode: string, errorText: string, wt: Worktree): void {
    stopDiffRefresh()
    detailCleanup(); detailCleanup = () => {}
    buildSyncErrorView({ mode, errorText, path: wt.path, showDetail, iconButton: iconBtn, status: path => taskGit.status(path) })
  }

  // ---- mutations ----
  async function createTask(name: string, repository = repoPath): Promise<void> {
    if (!name || !repository) return
    const branch = taskBranch(name)
    const path = taskPath(repository, branch.slice('feat/'.length))
    listWrap.replaceChildren(note(taskT('creatingTask'), 'db-detail-loading'))
    try {
      const base = await invoke<string>('git_default_branch', { repo: repository })
      await invoke('git_worktree_add', { repo: repository, path, branch, base })
      await load()
      const wt = worktrees.find(w => w.path === path)
      const row = [...listWrap.querySelectorAll<HTMLElement>('.tasks-row')].find(item => item.dataset.path === path)
      if (wt && row) {
        selectWorktree(row, wt)
        row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
      try {
        const result = await invoke<IsolateResult>('docker_compose_isolate', { worktreePath: path })
        if (wt) dockerView.show(result, wt)
      } catch (e) {
        // No root docker-compose.yml → maybe a devcontainer project (compose under .devcontainer/).
        if (String(e) !== 'no-compose') { showDetail(note(String(e), 'db-detail-error')); return }
        if (wt) {
          const prepared = await prepareTaskDevcontainer(wt)
          if (!prepared) showChanges(wt)
        }
      }
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
      await invoke('git_worktree_remove', { repo: repositoryFor(wt), path: wt.path, force: total > 0, branch: wt.branch ?? null })
      // Tear down the worktree's live agents hub (its worktree is gone) and drop
      // its persisted agents + scrollback so nothing is left orphaned.
      worktreeTerminals.get(wt.path)?.dispose()
      worktreeTerminals.delete(wt.path)
      try { localStorage.removeItem(`bento.agents.wt:${wt.path}.sessions`) } catch { /* ignore */ }
      void invoke('agent_history_clear', { scope: `bento.agents.wt:${wt.path}` }).catch(() => {})
      showDetail(note(taskT('selectTask'), 'db-detail-hint'))
      await load()
    } catch (e) { await askConfirm(String(e), { title: taskT('genericError'), kind: 'error' }) }
  }

  // ---- load ----
  async function loadMultiRepo(repos: string[]): Promise<void> {
    listWrap.replaceChildren(note(taskT('loading'), 'db-detail-loading'))
    repoOf.clear()
    baseOf.clear()
    ;[issueMap, prStatusMap, backupStatusMap, rebaseStatusMap, upstreamStatusMap].forEach(m => m.clear())
    aheadBehindMap.clear()
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
      jiraCfg = config
      worktrees = repoData.flatMap(({ repo, base, worktrees: items }) => {
        items.forEach(wt => {
          repoOf.set(wt.path, repo)
          baseOf.set(wt.path, base)
        })
        return items
      })
      const statuses = new Map<string, number>()
      await Promise.all(worktrees.map(async wt => {
        const base = baseFor(wt)
        const key = extractIssueKey(wt.branch ?? null)
        const [status, aheadBehind, issue, pr, backup, rebase, upstream] = await Promise.all([
          taskGit.safeStatus(wt.path),
          invoke<string>('git_ahead_behind', { path: wt.path, base }).catch(() => ''),
          key && jiraCfg ? fetchIssue(key, jiraCfg) : null,
          invoke<PrStatus | null>('git_pr_status', { path: wt.path }).catch(() => null),
          invoke<BackupStatus>('git_backup_status', { path: wt.path }).catch(() => ({ available: false, different: null, hash: null, short: null, subject: null })),
          invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false } as RebaseStatus)),
          invoke<UpstreamStatus | null>('git_upstream_status', { path: wt.path }).catch(() => null),
        ])
        statuses.set(wt.path, status.total)
        aheadBehindMap.set(wt.path, parseAheadBehind(aheadBehind))
        issueMap.set(wt.path, issue)
        prStatusMap.set(wt.path, pr)
        backupStatusMap.set(wt.path, backup)
        rebaseStatusMap.set(wt.path, rebase)
        if (upstream) upstreamStatusMap.set(wt.path, upstream)
      }))
      const runningPaths = new Set(worktrees.filter(wt => {
        const directory = wt.path.replace(/\/$/, '').split('/').pop()!
        return containers.some(container => isRunning(container) && container.name.startsWith(`${directory}-`))
      }).map(wt => wt.path))
      renderList(statuses, runningPaths)
    } catch (error) {
      listWrap.replaceChildren(note(String(error), 'db-detail-error'))
    }
  }

  async function load(): Promise<void> {
    const repos = panelStore.repositories()
    if (repos.length === 0) {
      baseSelect.disabled = true
      filterInput.style.display = 'none'
      baseRow.style.display = 'none'
      repoPath = ''
      updateRepoBtn()
      removeRepoBtn.style.display = 'none'
      refreshCreateForm()
      listWrap.replaceChildren(note(taskT('selectRepoHint')))
      return
    }
    // Protect the principal repo: only offer to remove it when another repo
    // remains, so a stray click can never leave Bento with no repositories.
    removeRepoBtn.style.display = repos.length > 1 ? '' : 'none'
    repoPath = repos[0]
    if (!repos.includes(selectedRepositoryPath)) selectedRepositoryPath = repoPath
    updateRepoBtn()
    if (repos.length > 1) {
      filterInput.style.display = ''
      baseRow.style.display = 'none'
      await loadMultiRepo(repos)
      return
    }
    baseSelect.disabled = false
    baseRow.style.display = ''
    await loadTaskData({
      repoPath,
      panelStore,
      baseSelect,
      filterInput,
      listWrap,
      fetchAgeEl,
      note,
      setBaseBranch: value => { baseBranch = value },
      setWorktrees: value => { worktrees = value },
      setJiraConfig: value => { jiraCfg = value },
      maps: { issue: issueMap, aheadBehind: aheadBehindMap, pr: prStatusMap, backup: backupStatusMap, rebase: rebaseStatusMap, upstream: upstreamStatusMap },
      renderList,
      selectRow,
      showChanges,
      showRebasePaused,
    })
    repoOf.clear()
    baseOf.clear()
    worktrees.forEach(w => {
      repoOf.set(w.path, repoPath)
      baseOf.set(w.path, baseBranch)
    })
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
  // Dispose all live worktree hubs when the panel/tab closes (persists each).
  const dispose = (): void => {
    for (const panel of worktreeTerminals.values()) panel.dispose()
    worktreeTerminals.clear()
  }
  return { element: root, dispose }
}
