import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { previewRebase, reorderByDrop, swapItems, type RebaseAction, type RebasePlanItem } from '../../core/git/rebaseWorkflow'
import type { CommitEntry, RebaseStatus, RewritePreflight } from '../../core/git/gitTypes'
import { taskT } from './i18n'
import { buildRebasePlanPreview } from './RebasePlanView'
import { buildCommitFileList } from './TaskCodeView'
import { taskGit } from './taskGitClient'
import type { TasksPanelCtx } from './tasksPanelContext'
import { showRebasePaused } from './tasksRebaseView'
import { baseFor, recordOperation } from './tasksPanelContext'
import { buildSubHead, iconBtn, showDetail } from './tasksPanelHelpers'
import { showChanges } from './tasksDiffView'
import { load } from './tasksLifecycle'

// ---- detail: interactive rebase ----

// El editor del rebase interactivo: reordenar, aplastar y editar mensajes
// antes de lanzarlo.

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
