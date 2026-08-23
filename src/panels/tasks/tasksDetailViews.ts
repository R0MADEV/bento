import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { open as pickFolder, confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { diffFileNames, changedPaths, matchingPaths, buildSelectedPatch, rankFixupCandidates } from '../../core/git/commitWorkflow'
import { parseAheadBehind } from '../../core/git/taskJira'
import { buildOperationHistoryView } from './OperationHistoryView'
import type { PrStatus, RebaseStatus, RewritePreflight } from './gitTypes'
import { buildPrStatusView } from './PrStatusView'
import { taskT } from './i18n'
import { buildBackupHistoryView } from './BackupHistoryView'
import { buildChangesFileView } from './ChangesFileView'
import { buildCommitFileList, fileStateMap, renderPatchHtml } from './TaskCodeView'
import { commitFilesRaw, recommendationMap, taskGit } from './taskGitClient'
import { buildResetView } from './ResetView'
import { buildGraphView } from './GraphView'
import { buildCommitLogView } from './CommitLogView'
import { buildSyncErrorView } from './TaskAuxiliaryViews'
import { buildIncomingChangesView } from './IncomingChangesView'
import type { TasksPanelCtx } from './tasksPanelContext'
import { baseFor, disposeDetail, projectKey, defaultProjectKey, recordOperation, repositoryFor, setDetailLifecycle, stopDiffRefresh } from './tasksPanelContext'
import { buildSubHead, iconBtn, note, showDetail } from './tasksPanelHelpers'
import { showRebasePaused } from './tasksRebaseView'
import { load } from './tasksLifecycle'
import { applyFilter } from './tasksListView'

// ---- detail: task/project settings ----
export async function showTaskSettings(ctx: TasksPanelCtx): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, note(taskT('loading'), 'db-detail-loading'))
  await ctx.settingsReady

  const wrap = document.createElement('div')
  wrap.className = 'tasks-settings-view'
  const title = Object.assign(document.createElement('h3'), { textContent: taskT('taskSettings') })
  const description = note(taskT('recipesDirHint'), 'db-detail-hint')
  const recipeProject = projectKey(ctx) || taskT('recipesExampleProject')
  const projectGuide = note(taskT('addProjectRecipeHint', { project: recipeProject }), 'db-detail-hint')
  const recipeExample = Object.assign(document.createElement('pre'), {
    className: 'tasks-settings-example',
    textContent: `${ctx.appSettings.devcontainerRecipesDir || '/ruta/a/bento-recipes'}/${recipeProject}/\n`+
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
    value: ctx.appSettings.devcontainerRecipesDir ?? '',
  })
  const status = note('', 'tasks-note')

  const keyLabel = Object.assign(document.createElement('label'), {
    className: 'tasks-settings-label',
    textContent: taskT('projectKey'),
  })
  const keyInput = Object.assign(document.createElement('input'), {
    className: 'tasks-settings-input',
    type: 'text',
    value: projectKey(ctx),
    placeholder: defaultProjectKey(ctx.repoPath),
  })
  keyInput.addEventListener('change', () => {
    ctx.panelStore.setProjectKey(keyInput.value === defaultProjectKey(ctx.repoPath) ? '' : keyInput.value)
    void showTaskSettings(ctx)
  })
  keyLabel.appendChild(keyInput)

  const persist = async (directory: string | undefined): Promise<void> => {
    ctx.appSettings = { ...ctx.appSettings, devcontainerRecipesDir: directory || undefined }
    input.value = directory ?? ''
    status.textContent = taskT('savingSettings')
    try {
      await ctx.settingsRepository.save(ctx.appSettings)
      status.textContent = taskT('settingsSaved')
    } catch (error) {
      status.className = 'db-detail-error'
      status.textContent = String(error)
    }
  }
  const choose = iconBtn('folder', taskT('chooseRecipesDir'), () => {
    void pickFolder({
      directory: true,
      defaultPath: ctx.appSettings.devcontainerRecipesDir,
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
  const recipePath = (): string | null => ctx.appSettings.devcontainerRecipesDir
    ? `${ctx.appSettings.devcontainerRecipesDir.replace(/\/$/, '')}/${projectKey(ctx)}`
    : null
  const createRecipe = iconBtn('plus', taskT('createRecipe'), () => {
    if (!ctx.appSettings.devcontainerRecipesDir) { status.textContent = taskT('selectRecipesDirFirst'); return }
    void invoke<string>('devcontainer_recipe_create', {
      recipesDir: ctx.appSettings.devcontainerRecipesDir,
      projectKey: projectKey(ctx),
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
    if (!ctx.appSettings.devcontainerRecipesDir) { status.textContent = taskT('selectRecipesDirFirst'); return }
    const message = action === 'commit' ? window.prompt(taskT('recipeCommitMessage')) : null
    if (action === 'commit' && !message) return
    status.className = 'tasks-note'
    status.textContent = taskT('recipeGitRunning', { action })
    void invoke<string>('devcontainer_recipe_git', {
      recipesDir: ctx.appSettings.devcontainerRecipesDir,
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
  showDetail(ctx, wrap)
}

// ---- detail: changes (GitHub-style diff + commit bar) ----
export async function showChanges(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  const requestVersion = ++ctx.detailVersion
  showDetail(ctx, note(taskT('loadingChanges'), 'db-detail-loading'))
  try {
    const [raw, statusRaw, rebaseStatus] = await Promise.all([
      invoke<string>('git_diff', { path: wt.path }),
      taskGit.safeStatus(wt.path),
      invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => ({ active: false })),
    ])
    if (requestVersion !== ctx.detailVersion) return
    const rebaseActive = rebaseStatus.active
    showDetail(ctx, buildDiffView(ctx, raw, wt, { statusRaw: statusRaw.raw, rebaseActive }))
    // Auto-refresh: re-fetch diff every 5 s and update if content changed
    let lastSnapshot = `${statusRaw.raw}\0${raw}`
    const refreshChanges = async (): Promise<void> => {
      const [newRaw, newStatus] = await Promise.all([
        invoke<string>('git_diff', { path: wt.path }).catch(() => null),
        taskGit.safeStatus(wt.path),
      ])
      if (requestVersion !== ctx.detailVersion) return
      const snapshot = `${newStatus.raw}\0${newRaw ?? ''}`
      if (newRaw !== null && snapshot !== lastSnapshot) {
        const draft = ctx.detailPane.querySelector<HTMLInputElement>('[data-testid="tasks-commit-message"]')
        // Replacing the entire diff also replaces the commit controls. Keep
        // the current DOM stable while the user (or WebDriver) is editing so
        // their text and the button they are about to activate cannot become
        // stale underneath them. Once editing ends, the pending snapshot is
        // intentionally retried on the next interval.
        if (draft && (draft.value.length > 0 || document.activeElement === draft)) return
        lastSnapshot = snapshot
        showDetail(ctx, buildDiffView(ctx, newRaw, wt, { statusRaw: newStatus.raw, rebaseActive }))
      }
    }
    const startDiffRefresh = (): void => {
      stopDiffRefresh(ctx)
      if (requestVersion !== ctx.detailVersion) return
      ctx.diffRefreshInterval = setInterval(() => { void refreshChanges() }, 5000)
    }
    startDiffRefresh()
    setDetailLifecycle(ctx, {
      pause: () => stopDiffRefresh(ctx),
      resume: () => { void refreshChanges(); startDiffRefresh() },
      dispose: () => stopDiffRefresh(ctx),
    })
  } catch (e) { showDetail(ctx, note(String(e), 'db-detail-error')) }
}

export function buildDiffView(ctx: TasksPanelCtx, raw: string, wt: Worktree, opts: { initMessage?: string; initAmend?: boolean; statusRaw?: string; rebaseActive?: boolean } = {}): HTMLElement {
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
    void showFixupPicker(ctx, wt, undefined, selectedPatch || raw, selectedPatch || undefined)
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
      recordOperation(ctx, wt, doAmend ? 'commit --amend' : 'commit', 'success', msg || taskT('keptMessage'))
      const wasAmend = doAmend
      msgInput.value = ''
      doAmend = false
      amendToggle.classList.remove('tasks-amend-btn--active')
      commitBtn.textContent = taskT('commit')
      const [newRaw, newStatus] = await Promise.all([
        invoke<string>('git_diff', { path: wt.path }),
        taskGit.safeStatus(wt.path),
      ])
      showDetail(ctx, buildDiffView(ctx, newRaw, wt, { statusRaw: newStatus.raw, rebaseActive: opts.rebaseActive }))
      showCommitStatus(wasAmend ? taskT('commitAmended') : taskT('commitCreated'))
      // Update sidebar badge and ahead/behind
      ctx.lastStatuses.set(wt.path, (await taskGit.safeStatus(wt.path)).total)
      const abRaw = await invoke<string>('git_ahead_behind', { path: wt.path, base: baseFor(ctx, wt) }).catch(() => '')
      ctx.aheadBehindMap.set(wt.path, parseAheadBehind(abRaw))
      applyFilter(ctx)
    } catch (e) {
      recordOperation(ctx, wt, doAmend ? 'commit --amend' : 'commit', 'error', String(e))
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
export async function showFixupPicker(ctx: TasksPanelCtx, wt: Worktree, files: string[] | undefined, incomingDiff: string, selectedPatch?: string): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, note(taskT('loadingCommits'), 'db-detail-loading'))
  try {
    const worktreeBase = baseFor(ctx, wt)
    const entries = await taskGit.rebaseLog(wt.path, worktreeBase)
    if (entries.length === 0) {
      showDetail(ctx, note(taskT('noOwnCommits', { base: worktreeBase }), 'db-detail-hint'))
      return
    }

    const incomingFiles = new Set(files ?? diffFileNames(incomingDiff))
    const [recommendations, blameRecommendations] = await Promise.all([
      taskGit.recommendations(wt.path, worktreeBase, [...incomingFiles]).catch(() => []),
      taskGit.blameRecommendations(wt.path, worktreeBase, incomingDiff).catch(() => []),
    ])
    const historyScores = recommendationMap(recommendations)
    const blameScores = recommendationMap(blameRecommendations)
    const scored = await Promise.all(entries.map(async entry => {
      const commitFiles = await taskGit.files(wt.path, entry.hash).catch(() => [])
      const filesRaw = commitFilesRaw(commitFiles)
      const overlap = matchingPaths(incomingFiles, changedPaths(filesRaw))
      const history = historyScores.get(entry.hash) ?? { score: 0, files: [] }
      const blame = blameScores.get(entry.hash) ?? { score: 0, files: [] }
      return { entry, commitFiles, overlap, history, blame }
    }))
    const enriched = rankFixupCandidates(scored)

    const wrap = document.createElement('div')
    wrap.className = 'tasks-fixup-wrap'
    wrap.append(buildSubHead(taskT('addChangesTitle'), () => void showChanges(ctx, wt)))
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
          recordOperation(ctx, wt, 'fixup + autosquash', 'success', `${entry.short} ${entry.subject}`)
          if (result === 'paused') {
            showRebasePaused(ctx, wt, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }))
            return
          }
          statusEl.textContent = taskT('changesIntegrated')
          setTimeout(() => { void showChanges(ctx, wt); void load(ctx) }, 900)
        } catch (e) {
          recordOperation(ctx, wt, 'fixup + autosquash', 'error', String(e))
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
    showDetail(ctx, wrap)
  } catch (e) {
    showDetail(ctx, note(String(e), 'db-detail-error'))
  }
}

// ---- detail: automatic history backups ----
export async function showBackupHistory(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, note(taskT('loadingBackups'), 'db-detail-loading'))
  try {
    showDetail(ctx, await buildBackupHistoryView({
      path: wt.path, branch: wt.branch ?? '', renderPatch: renderPatchHtml,
      onBack: () => void showChanges(ctx, wt),
      onRestored: async () => { await load(ctx); void showChanges(ctx, wt) },
      onOperation: (status, detail) => recordOperation(ctx, wt, taskT('restoreBackup'), status, detail),
    }))
  } catch (e) { showDetail(ctx, note(String(e), 'db-detail-error')) }
}

export function showOperationHistory(ctx: TasksPanelCtx, wt: Worktree): void {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  const branch = wt.branch ?? taskT('detached')
  const repository = repositoryFor(ctx, wt)
  showDetail(ctx, buildOperationHistoryView({
    branch,
    repository,
    entries: ctx.panelStore.operations(),
    onBack: () => void showChanges(ctx, wt),
    onClear: () => {
      ctx.panelStore.clearOperations(repository, branch)
      showOperationHistory(ctx, wt)
    },
  }))
}

// ---- detail: reset commits ----
export function showResetView(ctx: TasksPanelCtx, wt: Worktree): void {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, buildResetView({
    worktree: wt,
    baseBranch: baseFor(ctx, wt),
    buildSubHead,
    onBack: () => void showChanges(ctx, wt),
    onComplete: () => { void showChanges(ctx, wt); void load(ctx) },
    recordOperation: (operation, status, detail) => recordOperation(ctx, wt, operation, status, detail),
  }))
}

// ---- detail: commit log ----
export async function showCommitGraph(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  await buildGraphView({
    worktree: wt,
    baseBranch: baseFor(ctx, wt),
    buildSubHead,
    onBack: () => void showChanges(ctx, wt),
    showDetail: (...nodes) => showDetail(ctx, ...nodes),
    note,
  })
}

export function showPrDetails(ctx: TasksPanelCtx, wt: Worktree, pr: PrStatus): void {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, buildPrStatusView({
    pr, baseBranch: baseFor(ctx, wt),
    onBack: () => void showChanges(ctx, wt),
    onOpen: () => openUrl(pr.url).catch(() => {}),
  }))
}

export async function showCommitLog(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, note(taskT('loadingHistory'), 'db-detail-loading'))
  try {
    const entries = await taskGit.log(wt.path)
    buildCommitLogView({
      worktree: wt,
      entries,
      buildSubHead,
      onBack: () => void showChanges(ctx, wt),
      showDetail: (...nodes) => showDetail(ctx, ...nodes),
      note,
      iconBtn,
      buildCommitFileList,
      loadFiles: (path, hash) => taskGit.files(path, hash).catch(() => []),
    })
  } catch (err) { showDetail(ctx, note(String(err), 'db-detail-error')) }
}

// ---- detail: worktree terminal ----
export async function showWorktreeTerminal(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  const { createAgentsPanel } = await import('../agents/AgentsPanel')
  // Reuse the live hub for this worktree if we already opened it; otherwise
  // create one scoped to the worktree (own storage, off the global dock).
  let panel = ctx.worktreeTerminals.get(wt.path)
  if (!panel) {
    panel = createAgentsPanel(wt.path, { storageScope: `bento.agents.wt:${wt.path}`, publishToDock: false })
    ctx.worktreeTerminals.set(wt.path, panel)
  }
  const wrap = document.createElement('div')
  wrap.className = 'tasks-term-wrap'
  const termBody = document.createElement('div')
  termBody.className = 'tasks-term-body'
  termBody.appendChild(panel.element)
  wrap.append(buildSubHead(`Terminal · ${wt.branch ?? ''}`, () => void showChanges(ctx, wt)), termBody)
  showDetail(ctx, wrap)
  requestAnimationFrame(() => panel!.fit())
  // Navigating away only detaches the element (showDetail replaces it); the
  // hub stays alive in the cache, so the agents keep running. Persist on leave
  // so they're restorable even if the tab closes without a clean dispose.
  const livePanel = panel
  setDetailLifecycle(ctx, {
    pause: () => {},
    resume: () => livePanel.fit(),
    dispose: () => livePanel.persist(),
  })
}

// ---- detail: git sync error (with conflict detection + AI explain) ----
export function showSyncError(ctx: TasksPanelCtx, mode: string, errorText: string, wt: Worktree): void {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  buildSyncErrorView({ mode, errorText, path: wt.path, showDetail: (...nodes) => showDetail(ctx, ...nodes), iconButton: iconBtn, status: path => taskGit.status(path) })
}
