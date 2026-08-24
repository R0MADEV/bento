import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { showChanges } from './tasksDiffView'
import { buildOperationHistoryView } from './OperationHistoryView'
import type { PrStatus } from '../../core/git/gitTypes'
import { buildPrStatusView } from './PrStatusView'
import { taskT } from './i18n'
import { buildBackupHistoryView } from './BackupHistoryView'
import { buildCommitFileList, renderPatchHtml } from './TaskCodeView'
import { taskGit } from './taskGitClient'
import { buildResetView } from './ResetView'
import { buildGraphView } from './GraphView'
import { buildCommitLogView } from './CommitLogView'
import { buildSyncErrorView } from './TaskAuxiliaryViews'
import type { TasksPanelCtx } from './tasksPanelContext'
import { baseFor, disposeDetail, projectKey, defaultProjectKey, recordOperation, repositoryFor, setDetailLifecycle, stopDiffRefresh } from './tasksPanelContext'
import { buildSubHead, iconBtn, note, showDetail } from './tasksPanelHelpers'
import { load } from './tasksLifecycle'

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
