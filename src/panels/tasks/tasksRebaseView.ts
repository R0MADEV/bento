import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import type { CommitEntry, RebaseStatus } from '../../core/git/gitTypes'
import { taskT } from './i18n'
import { buildConflictResolverView } from './ConflictResolverView'
import { taskGit } from './taskGitClient'
import { buildRebaseMergeWarning } from './RebaseMergeWarningView'
import type { TasksPanelCtx } from './tasksPanelContext'
import { showRebaseEditor } from './tasksRebaseEditor'
import { baseFor, disposeDetail, recordOperation, setDetailLifecycle, stopDiffRefresh } from './tasksPanelContext'
import { buildSubHead, showDetail } from './tasksPanelHelpers'
import { buildDiffView, showChanges } from './tasksDiffView'
import { load } from './tasksLifecycle'
import { note } from './tasksPanelHelpers'

// ---- detail: interactive rebase ----

export async function showInteractiveRebase(ctx: TasksPanelCtx, wt: Worktree): Promise<void> {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, note(taskT('loading'), 'db-detail-loading'))
  try {
    const st = await invoke<RebaseStatus>('git_rebase_status', { path: wt.path })
    if (st.active) { showRebasePaused(ctx, wt, st); return }

    const worktreeBase = baseFor(ctx, wt)
    const [entries, merges] = await Promise.all([
      taskGit.rebaseLog(wt.path, worktreeBase),
      taskGit.mergeLog(wt.path, worktreeBase).catch(() => []),
    ])
    if (entries.length === 0) {
      showDetail(ctx, note(taskT('noOwnCommits', { base: worktreeBase }), 'db-detail-hint'))
      return
    }
    if (merges.length) showMergeRebaseWarning(ctx, wt, entries, merges)
    else showRebaseEditor(ctx, wt, entries)
  } catch (e) { showDetail(ctx, note(String(e), 'db-detail-error')) }
}

export function showMergeRebaseWarning(ctx: TasksPanelCtx, wt: Worktree, entries: CommitEntry[], merges: CommitEntry[]): void {
  buildRebaseMergeWarning({
    worktree: wt,
    baseBranch: baseFor(ctx, wt),
    entries,
    merges,
    buildSubHead,
    onBack: () => void showChanges(ctx, wt),
    showDetail: (...nodes) => showDetail(ctx, ...nodes),
    showRebaseEditor: (worktree, items) => showRebaseEditor(ctx, worktree, items),
    showRebasePaused: (worktree, status) => showRebasePaused(ctx, worktree, status),
    recordOperation: (operation, status, detail) => recordOperation(ctx, wt, operation, status, detail),
    onComplete: () => { void showChanges(ctx, wt); void load(ctx) },
  })
}

export function showConflictResolver(ctx: TasksPanelCtx, wt: Worktree, file: string, onBack: () => void): void {
  stopDiffRefresh(ctx)
  disposeDetail(ctx)
  showDetail(ctx, buildConflictResolverView({ path: wt.path, file, onBack }))
}

export function showRebasePaused(ctx: TasksPanelCtx, wt: Worktree, st: RebaseStatus): void {
  disposeDetail(ctx)
  const wrap = document.createElement('div')
  wrap.className = 'tasks-rebase-paused'

  wrap.append(buildSubHead(taskT('pausedTitle', { branch: wt.branch ?? '' }), () => void showChanges(ctx, wt)))

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
  const stopPolling = (): void => {
    clearInterval(intervalId)
    intervalId = 0
  }
  let resumePolling: () => void

  editBtn.addEventListener('click', () => void showChanges(ctx, wt))
  splitBtn.addEventListener('click', async () => {
    const ok = await askConfirm(
      taskT('splitQuestion'),
      { title: taskT('splitTitle'), kind: 'warning' },
    )
    if (!ok) return
    splitBtn.disabled = true
    try {
      await invoke('git_rebase_split', { path: wt.path })
      recordOperation(ctx, wt, 'dividir commit', 'success', st.short ?? st.subject ?? '')
      void showChanges(ctx, wt)
    } catch (e) {
      recordOperation(ctx, wt, 'dividir commit', 'error', String(e))
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
        showRebasePaused(ctx, wt, await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }))
      } else {
        statusEl.textContent = taskT('rebaseComplete')
        setTimeout(() => { void showChanges(ctx, wt); void load(ctx) }, 1200)
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
    void showChanges(ctx, wt); void load(ctx)
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
            showConflictResolver(ctx, wt, file, () => {
              resolved.add(file)
              showRebasePaused(ctx, wt, st)
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
    const refreshConflicts = async (): Promise<void> => {
      const fresh = await invoke<RebaseStatus>('git_rebase_status', { path: wt.path }).catch(() => null)
      if (!fresh) return
      if (!fresh.active) { stopPolling(); void showChanges(ctx, wt); void load(ctx); return }
      const freshConflicts = fresh.conflicts ?? []
      freshConflicts.forEach(f => { if (!freshConflicts.includes(f)) resolved.delete(f) })
      if (freshConflicts.length === 0) {
        stopPolling()
        showRebasePaused(ctx, wt, fresh)
      } else {
        renderConflicts(freshConflicts)
      }
    }
    const startPolling = (): void => {
      stopPolling()
      intervalId = window.setInterval(() => { void refreshConflicts() }, 4000)
    }
    resumePolling = () => { void refreshConflicts(); startPolling() }
    startPolling()

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
        diffWrap.replaceChildren(buildDiffView(ctx, raw, wt, { initAmend: true, initMessage: st.subject ?? '' }))
      }).catch(() => {})
    }
    refreshDiff()
    const startPolling = (): void => {
      stopPolling()
      intervalId = window.setInterval(refreshDiff, 5000)
    }
    resumePolling = () => { refreshDiff(); startPolling() }
    startPolling()
    wrap.appendChild(diffWrap)
  }

  setDetailLifecycle(ctx, { pause: stopPolling, resume: resumePolling!, dispose: stopPolling })
  actionsEl.append(statusEl, abortBtn, editBtn, splitBtn, continueBtn)
  wrap.appendChild(actionsEl)
  showDetail(ctx, wrap)
}
