import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { previewRebase, reorderByDrop, swapItems, type RebaseAction, type RebasePlanItem } from '../../core/git/rebaseWorkflow'
import type { CommitEntry, RebaseStatus, RewritePreflight } from './gitTypes'
import { taskT } from './i18n'
import { buildConflictResolverView } from './ConflictResolverView'
import { buildRebasePlanPreview } from './RebasePlanView'
import { buildCommitFileList } from './TaskCodeView'
import { taskGit } from './taskGitClient'
import { buildRebaseMergeWarning } from './RebaseMergeWarningView'
import type { TasksPanelCtx } from './tasksPanelContext'
import { baseFor, disposeDetail, recordOperation, setDetailLifecycle, stopDiffRefresh } from './tasksPanelContext'
import { buildSubHead, iconBtn, showDetail } from './tasksPanelHelpers'
import { buildDiffView, showChanges } from './tasksDetailViews'
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

export function showRebaseEditor(ctx: TasksPanelCtx, wt: Worktree, entries: CommitEntry[]): void {
  type RebaseItem = RebasePlanItem & { action: RebaseAction; newMessage: string }
  let items: RebaseItem[] = entries.map(e => ({ action: 'pick', hash: e.hash, short: e.short, subject: e.subject, newMessage: '' }))
  const ACTIONS: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']
  let draggedIndex: number | null = null
  let dragTarget: { index: number; after: boolean } | null = null

  const wrap = document.createElement('div')
  wrap.className = 'tasks-rebase-wrap'
  wrap.append(buildSubHead(taskT('interactiveTitle', { branch: wt.branch ?? '', base: baseFor(ctx, wt) }), () => void showChanges(ctx, wt)))

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
        items = reorderByDrop(items, from, index, after)
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
        items = swapItems(items, idx - 1, idx)
        renderList()
      })
      const downBtn = iconBtn('chevron-down', taskT('moveDown'), () => {
        if (idx === items.length - 1) return
        items = swapItems(items, idx + 1, idx)
        renderList()
      })
      upBtn.disabled = idx === 0
      downBtn.disabled = idx === items.length - 1

      row.addEventListener('keydown', e => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        const target = e.key === 'ArrowUp' ? idx - 1 : idx + 1
        if (target < 0 || target >= items.length) return
        items = swapItems(items, target, idx)
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
      preflight = await invoke<RewritePreflight>('git_rewrite_preflight', { path: wt.path, base: baseFor(ctx, wt) })
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
      await invoke('git_rebase_start', { path: wt.path, base: baseFor(ctx, wt), todoLines })
      recordOperation(ctx, wt, 'rebase interactivo', 'success', `${items.length} instrucciones sobre origin/${baseFor(ctx, wt)}`)
      const st = await invoke<RebaseStatus>('git_rebase_status', { path: wt.path })
      if (st.active) {
        // If this commit was a reword, pre-fill the message with the new title
        const preMsg = rewordMessages.get(st.sha ?? '') ?? st.subject ?? ''
        showRebasePaused(ctx, wt, { ...st, subject: preMsg })
        return
      }
      statusEl.textContent = taskT('rebaseComplete')
      setTimeout(() => { void showChanges(ctx, wt); void load(ctx) }, 1200)
    } catch (e) {
      recordOperation(ctx, wt, 'rebase interactivo', 'error', String(e))
      statusEl.textContent = String(e).slice(0, 120)
      startBtn.disabled = false
    }
  })
  footer.append(statusEl, previewBtn, startBtn)
  wrap.appendChild(footer)
  showDetail(ctx, wrap)
}

// ---- Inline conflict resolver ----
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
