import type { Worktree } from '../../core/git/worktree'
import type { AppSettings } from '../../ports/AppSettingsRepository'
import { TauriAppSettingsRepository } from '../../adapters/TauriAppSettingsRepository'
import { TaskPanelStore } from './TaskPanelStore'
import { createTaskDockerView } from './TaskDockerView'
import type { JiraConfig, TaskIssue } from './taskJiraClient'
import type { BackupStatus, PrStatus, RebaseStatus, UpstreamStatus } from './gitTypes'
import type { DetailLifecycle } from '../docker/containerDetail'

// The former single closure over `createTasksPanel` split into a mutable
// context object so the view/lifecycle functions that used to be nested
// inside it can live in separate files. Every field here was a `let`/`const`
// captured by closure in the original file; passing this object by reference
// preserves the exact same sharing semantics (in particular the
// selectionVersion/detailVersion race-guard comparisons, which only work
// because every reader sees the same live object, not a copy).
export interface TasksPanelCtx {
  panelId: string
  panelStore: TaskPanelStore
  settingsRepository: TauriAppSettingsRepository
  appSettings: AppSettings
  settingsReady: Promise<void>

  worktrees: Worktree[]
  repoPath: string
  panelVisible: boolean
  selectedRow: HTMLElement | null
  selectedWorktreePath: string
  selectedRepositoryPath: string
  selectionVersion: number
  detailVersion: number
  filterText: string
  repoOf: Map<string, string>
  baseOf: Map<string, string>
  collapsedRepos: Set<string>
  lastStatuses: Map<string, number>
  lastRunningPaths: Set<string>
  baseBranch: string
  jiraCfg: JiraConfig | null
  issueMap: Map<string, TaskIssue | null>
  aheadBehindMap: Map<string, { ahead: number; behind: number }>
  prStatusMap: Map<string, PrStatus | null>
  backupStatusMap: Map<string, BackupStatus>
  rebaseStatusMap: Map<string, RebaseStatus>
  upstreamStatusMap: Map<string, UpstreamStatus>
  diffRefreshInterval: ReturnType<typeof setInterval> | null
  worktreeTerminals: Map<string, { element: HTMLElement; fit: () => void; persist: () => void; dispose: () => void }>

  detailCleanup: () => void
  detailPause: () => void
  detailResume: () => void

  root: HTMLElement
  repoBtn: HTMLButtonElement
  removeRepoBtn: HTMLButtonElement
  repoRow: HTMLElement
  baseSelect: HTMLSelectElement
  baseRow: HTMLElement
  fetchAgeEl: HTMLElement
  filterInput: HTMLInputElement
  listWrap: HTMLElement
  progressFooter: HTMLElement
  createFormWrap: HTMLElement
  detailPane: HTMLElement
  dockerView: ReturnType<typeof createTaskDockerView>

  // Assigned once the sidebar (`cs`) exists; a no-op until then. Kept as a
  // mutable field (not a plain function export) because it closes over `cs`,
  // which is built in TasksPanelRuntime.ts's DOM scaffold.
  refreshMiniItems: () => void
  // Repaints repoBtn's icon+label from ctx.repoPath. Same deferred-assignment
  // reason as refreshMiniItems: it closes over the repoBtn element built in
  // TasksPanelRuntime.ts's DOM scaffold.
  updateRepoBtn: () => void
}

export function createTasksPanelCtx(panelId: string): TasksPanelCtx {
  const panelStore = new TaskPanelStore(panelId)
  const settingsRepository = new TauriAppSettingsRepository()
  const ctx: TasksPanelCtx = {
    panelId,
    panelStore,
    settingsRepository,
    appSettings: {},
    settingsReady: Promise.resolve(),

    worktrees: [],
    repoPath: panelStore.repository(),
    panelVisible: true,
    selectedRow: null,
    selectedWorktreePath: panelStore.selected() ?? '',
    selectedRepositoryPath: '',
    selectionVersion: 0,
    detailVersion: 0,
    filterText: '',
    repoOf: new Map(),
    baseOf: new Map(),
    collapsedRepos: new Set(),
    lastStatuses: new Map(),
    lastRunningPaths: new Set(),
    baseBranch: panelStore.base(),
    jiraCfg: null,
    issueMap: new Map(),
    aheadBehindMap: new Map(),
    prStatusMap: new Map(),
    backupStatusMap: new Map(),
    rebaseStatusMap: new Map(),
    upstreamStatusMap: new Map(),
    diffRefreshInterval: null,
    worktreeTerminals: new Map(),

    detailCleanup: () => {},
    detailPause: () => {},
    detailResume: () => {},

    // Placeholders — TasksPanelRuntime.ts overwrites these once the real DOM
    // scaffold exists. Typed as non-null here to avoid `| undefined` noise
    // through every view function's signature.
    root: document.createElement('div'),
    repoBtn: document.createElement('button'),
    removeRepoBtn: document.createElement('button'),
    repoRow: document.createElement('div'),
    baseSelect: document.createElement('select'),
    baseRow: document.createElement('div'),
    fetchAgeEl: document.createElement('span'),
    filterInput: document.createElement('input'),
    listWrap: document.createElement('div'),
    progressFooter: document.createElement('div'),
    createFormWrap: document.createElement('div'),
    detailPane: document.createElement('div'),
    dockerView: null as unknown as ReturnType<typeof createTaskDockerView>,

    refreshMiniItems: () => {},
    updateRepoBtn: () => {},
  }
  ctx.selectedRepositoryPath = ctx.repoPath
  ctx.settingsReady = settingsRepository.load().then(settings => { ctx.appSettings = settings }).catch(() => {})
  return ctx
}

export function setDetailLifecycle(ctx: TasksPanelCtx, lifecycle: DetailLifecycle): void {
  ctx.detailCleanup = lifecycle.dispose
  ctx.detailPause = lifecycle.pause
  ctx.detailResume = lifecycle.resume
  if (!ctx.panelVisible) ctx.detailPause()
}

export function disposeDetail(ctx: TasksPanelCtx): void {
  // Invalidate async work started by the outgoing detail. Stopping an
  // interval is not enough when one of its refresh requests is already in
  // flight: without a new generation it could finish later and replace the
  // newly opened commit/rebase/conflict UI.
  ctx.detailVersion += 1
  const cleanup = ctx.detailCleanup
  ctx.detailCleanup = () => {}
  ctx.detailPause = () => {}
  ctx.detailResume = () => {}
  cleanup()
}

export function stopDiffRefresh(ctx: TasksPanelCtx): void {
  if (ctx.diffRefreshInterval !== null) { clearInterval(ctx.diffRefreshInterval); ctx.diffRefreshInterval = null }
}

export function repositoryFor(ctx: TasksPanelCtx, wt: Worktree): string {
  return ctx.repoOf.get(wt.path) ?? ctx.repoPath
}

export function baseFor(ctx: TasksPanelCtx, wt: Worktree): string {
  return ctx.baseOf.get(wt.path) ?? ctx.baseBranch
}

export function recordOperation(ctx: TasksPanelCtx, wt: Worktree, operation: string, status: 'success' | 'error', detail: string): void {
  ctx.panelStore.recordOperation(repositoryFor(ctx, wt), wt.branch ?? '(detached)', operation, status, detail)
}

export function selectRow(ctx: TasksPanelCtx, row: HTMLElement): void {
  ctx.selectedRow?.classList.remove('tasks-row--selected')
  ctx.selectedRow = row
  row.classList.add('tasks-row--selected')
}

export function selectWorktree(ctx: TasksPanelCtx, row: HTMLElement, wt: Worktree): number {
  selectRow(ctx, row)
  ctx.selectedWorktreePath = wt.path
  ctx.selectedRepositoryPath = repositoryFor(ctx, wt)
  ctx.panelStore.setSelected(wt.path)
  ctx.selectionVersion += 1
  ctx.detailVersion += 1
  ctx.refreshMiniItems()
  return ctx.selectionVersion
}

export function isCurrentSelection(ctx: TasksPanelCtx, version: number, wt: Worktree): boolean {
  const isSameSelectionVersion = version === ctx.selectionVersion
  return isSameSelectionVersion && ctx.selectedWorktreePath === wt.path
}

export function selectedRepository(ctx: TasksPanelCtx): string {
  return ctx.selectedRepositoryPath || ctx.repoPath
}

export function defaultProjectKey(repository: string): string {
  return repository.replace(/\/$/, '').split('/').pop() ?? ''
}

export function projectKey(ctx: TasksPanelCtx, repository = ctx.repoPath): string {
  return ctx.panelStore.projectKey() || defaultProjectKey(repository)
}

export async function prepareTaskDevcontainer(ctx: TasksPanelCtx, worktree: Worktree): Promise<boolean> {
  await ctx.settingsReady
  ctx.appSettings = await ctx.settingsRepository.load().catch(() => ctx.appSettings)
  return ctx.dockerView.prepareDevcontainer(
    worktree,
    ctx.appSettings.devcontainerRecipesDir,
    projectKey(ctx, repositoryFor(ctx, worktree)),
    ctx.panelStore.devcontainerDir() ?? undefined,
    path => ctx.panelStore.setDevcontainerDir(path),
  )
}
