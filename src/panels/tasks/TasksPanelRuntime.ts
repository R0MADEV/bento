import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { icon } from '../../ui/helpers/icons'
import { taskT } from './i18n'
import { createTaskDockerView } from './TaskDockerView'
import { createCollapsibleSidebar } from '../../ui/collapsibleSidebar'
import {
  createTasksPanelCtx, disposeDetail, setDetailLifecycle, stopDiffRefresh, type TasksPanelCtx,
} from './tasksPanelContext'
import { iconBtn, note, showDetail } from './tasksPanelHelpers'
import { applyFilter } from './tasksListView'
import { showTaskSettings } from './tasksDetailViews'
import { load } from './tasksLifecycle'

// The panel used to be one closure over ~30 shared mutable variables with
// ~30 nested functions. It is now a plain mutable `TasksPanelCtx` (see
// tasksPanelContext.ts) threaded explicitly through view/lifecycle
// functions split across tasksListView.ts, tasksDetailViews.ts,
// tasksRebaseView.ts and tasksLifecycle.ts. This file only builds the DOM
// scaffold (sidebar, filter, controls) and wires it to those functions.
export function createTasksPanel(panelId = 'default'): { element: HTMLElement; dispose: () => void; onVisibilityChange: (visible: boolean) => void } {
  const ctx = createTasksPanelCtx(panelId)

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
    const name = ctx.repoPath ? ctx.repoPath.replace(/\/$/, '').split('/').pop()! : taskT('selectRepoShort')
    repoBtn.replaceChildren()
    const iconSlot = document.createElement('span')
    iconSlot.innerHTML = icon('folder')
    const label = document.createElement('span')
    label.textContent = name
    repoBtn.append(iconSlot, label)
  }
  updateRepoBtn()
  ctx.updateRepoBtn = updateRepoBtn
  repoBtn.addEventListener('click', async () => {
    const picked = await pickFolder({ directory: true, defaultPath: ctx.repoPath || undefined }).catch(() => null)
    if (!picked || typeof picked !== 'string') return
    // Add to the repo list (multi-repo). First pick behaves as before (one repo).
    ctx.panelStore.addRepository(picked)
    void load(ctx)
  })

  const baseSelect = document.createElement('select')
  baseSelect.className = 'tasks-base-select'
  baseSelect.title = taskT('baseBranch')
  baseSelect.addEventListener('change', () => {
    ctx.baseBranch = baseSelect.value
    ctx.panelStore.setBase(ctx.baseBranch)
    void load(ctx)
  })
  const fetchAgeEl = document.createElement('span')
  fetchAgeEl.className = 'tasks-fetch-age'
  const refreshBtn = iconBtn('refresh', taskT('reload'), () => void load(ctx))
  const settingsBtn = iconBtn('settings', taskT('taskSettings'), () => { void showTaskSettings(ctx) })
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
  filterInput.addEventListener('input', () => { ctx.filterText = filterInput.value; applyFilter(ctx) })

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
    if (!ctx.repoPath) return
    ctx.panelStore.removeRepository(ctx.repoPath)
    void load(ctx)
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

  ctx.root = root
  ctx.repoBtn = repoBtn
  ctx.removeRepoBtn = removeRepoBtn
  ctx.repoRow = repoRow
  ctx.baseSelect = baseSelect
  ctx.baseRow = baseRow
  ctx.fetchAgeEl = fetchAgeEl
  ctx.filterInput = filterInput
  ctx.listWrap = listWrap
  ctx.progressFooter = progressFooter
  ctx.createFormWrap = createFormWrap
  ctx.detailPane = detailPane

  ctx.refreshMiniItems = (): void => {
    cs.setMiniItems(ctx.worktrees.map(wt => {
      const changes = ctx.lastStatuses.get(wt.path) ?? 0
      const hasRunning = ctx.lastRunningPaths.has(wt.path)
      return {
        label: wt.branch ?? wt.path.replace(/\/$/, '').split('/').pop() ?? wt.path,
        dot: hasRunning ? 'working' : changes > 0 ? 'blocked' : undefined,
        active: wt.path === ctx.selectedWorktreePath,
        onClick: () => listWrap.querySelector<HTMLElement>(`[data-path="${CSS.escape(wt.path)}"]`)?.click(),
      }
    }))
  }

  ctx.dockerView = createTaskDockerView({
    showDetail: (...nodes) => showDetail(ctx, ...nodes),
    resetDetail: () => { stopDiffRefresh(ctx); disposeDetail(ctx) },
    setLifecycle: lifecycle => setDetailLifecycle(ctx, lifecycle),
  })

  showDetail(ctx, note(taskT('selectTask'), 'db-detail-hint'))

  filterInput.style.display = 'none'
  void load(ctx)
  // Dispose all live worktree hubs when the panel/tab closes (persists each).
  const dispose = (): void => {
    stopDiffRefresh(ctx)
    disposeDetail(ctx)
    for (const panel of ctx.worktreeTerminals.values()) panel.dispose()
    ctx.worktreeTerminals.clear()
  }
  return {
    element: root,
    dispose,
    onVisibilityChange: (visible: boolean) => {
      ctx.panelVisible = visible
      if (!visible) ctx.detailPause()
      else ctx.detailResume()
    },
  }
}

export type { TasksPanelCtx }
