import type { Worktree } from '../../core/git/worktree'
import { buildRow } from './tasksListRow'
import { filterWorktrees, groupWorktreesByRepo } from '../../core/git/worktreeList'
import { icon } from '../../ui/helpers/icons'
import { taskT } from './i18n'
import { taskProgress } from './taskProgress'
import type { TasksPanelCtx } from './tasksPanelContext'
import {

  selectedRepository,
} from './tasksPanelContext'
import { iconBtn, note } from './tasksPanelHelpers'
import { createTask, load } from './tasksLifecycle'

// ---- list ----

export function renderList(ctx: TasksPanelCtx, statuses: Map<string, number>, runningPaths: Set<string>): void {
  ctx.lastStatuses = statuses
  ctx.lastRunningPaths = runningPaths
  applyFilter(ctx)
}

export function progressBar(label: string, v: { done: number; total: number }): HTMLElement {
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

export function updateProgress(ctx: TasksPanelCtx): void {
  const p = taskProgress(ctx.worktrees, ctx.lastStatuses, ctx.aheadBehindMap)
  ctx.progressFooter.replaceChildren(
    progressBar(taskT('tasksClean'), p.clean),
    progressBar(taskT('tasksSynced'), p.synced),
  )
}

export function applyFilter(ctx: TasksPanelCtx): void {
  updateProgress(ctx)
  const filtered = filterWorktrees(ctx.worktrees, ctx.filterText)

  ctx.listWrap.replaceChildren()
  refreshCreateForm(ctx)
  if (filtered.length === 0) {
    ctx.listWrap.append(note(ctx.worktrees.length === 0 ? taskT('noWorktrees') : taskT('noResults')))
    ctx.refreshMiniItems()
    return
  }

  // Single repo → one group.
  const byRepo = groupWorktreesByRepo(filtered, ctx.repoOf, ctx.repoPath)
  for (const [repo, wts] of byRepo) ctx.listWrap.appendChild(buildProjectGroup(ctx, repo, wts))
  ctx.refreshMiniItems()
}

// Collapsible project header (repo name + count) grouping that repo's worktrees.

export function buildProjectGroup(ctx: TasksPanelCtx, repo: string, wts: Worktree[]): HTMLElement {
  const repoRoot = repo.replace(/\/$/, '')
  const group = document.createElement('div')
  group.className = `tasks-project${ctx.collapsedRepos.has(repo) ? ' collapsed' : ''}`
  const header = document.createElement('div')
  header.className = 'tasks-project-header'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'tasks-project-toggle'
  toggle.setAttribute('aria-expanded', String(!ctx.collapsedRepos.has(repo)))
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
  if (ctx.panelStore.repositories().length > 1) {
    const remove = Object.assign(document.createElement('button'), {
      type: 'button', className: 'tasks-project-remove', textContent: '×', title: taskT('removeRepo'),
    })
    remove.addEventListener('click', e => { e.stopPropagation(); ctx.panelStore.removeRepository(repo); void load(ctx) })
    header.appendChild(remove)
  }
  toggle.addEventListener('click', () => {
    ctx.selectedRepositoryPath = repo
    if (ctx.collapsedRepos.has(repo)) ctx.collapsedRepos.delete(repo); else ctx.collapsedRepos.add(repo)
    group.classList.toggle('collapsed')
    toggle.setAttribute('aria-expanded', String(!ctx.collapsedRepos.has(repo)))
  })
  const list = document.createElement('div')
  list.className = 'tasks-list'
  wts.forEach(wt => {
    const isMain = wt.path.replace(/\/$/, '') === repoRoot
    list.appendChild(buildRow(ctx, wt, isMain, ctx.lastStatuses.get(wt.path) ?? 0, ctx.lastRunningPaths.has(wt.path)))
  })
  group.append(header, list)
  return group
}

export function buildCreateForm(ctx: TasksPanelCtx): HTMLElement {
  const form = document.createElement('div')
  form.className = 'tasks-create'
  const repos = ctx.panelStore.repositories()

  let repoSelect: HTMLSelectElement | undefined
  if (repos.length > 1) {
    repoSelect = document.createElement('select')
    repoSelect.className = 'tasks-create-repo'
    repoSelect.title = taskT('selectRepo')
    for (const repo of repos) {
      repoSelect.appendChild(Object.assign(document.createElement('option'), {
        value: repo,
        textContent: repo.replace(/\/$/, '').split('/').pop() ?? repo,
        selected: repo === selectedRepository(ctx),
      }))
    }
    repoSelect.addEventListener('change', () => { ctx.selectedRepositoryPath = repoSelect!.value })
  }

  const input = Object.assign(document.createElement('input'), { className: 'tasks-name-input', type: 'text', placeholder: taskT('newTask') })
  const submit = (): void => { void createTask(ctx, input.value.trim(), repoSelect?.value || selectedRepository(ctx)) }
  const btn = iconBtn('plus', taskT('createTask'), submit)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit() })

  if (repoSelect) form.append(repoSelect, input, btn)
  else form.append(input, btn)
  return form
}

// Rebuilds the footer create form so its repo selector reflects the current
// repo list. Called from load()/applyFilter after the repo set may change.

export function refreshCreateForm(ctx: TasksPanelCtx): void {
  ctx.createFormWrap.replaceChildren(ctx.panelStore.repositories().length > 0 ? buildCreateForm(ctx) : document.createDocumentFragment())
}
