import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { buildSelectedPatch } from './taskPatch'
import { parseAheadBehind } from '../../core/git/taskJira'
import type { RebaseStatus, RewritePreflight } from '../../core/git/gitTypes'
import { taskT } from './i18n'
import { buildChangesFileView } from './ChangesFileView'
import { buildCommitFileList, fileStateMap, renderPatchHtml } from './TaskCodeView'
import { taskGit } from './taskGitClient'
import { buildIncomingChangesView } from './IncomingChangesView'
import type { TasksPanelCtx } from './tasksPanelContext'
import { baseFor, disposeDetail, recordOperation, setDetailLifecycle, stopDiffRefresh } from './tasksPanelContext'
import { buildSubHead, iconBtn, note, showDetail } from './tasksPanelHelpers'
import { showRebasePaused } from './tasksRebaseView'
import { load } from './tasksLifecycle'
import { applyFilter } from './tasksListView'

// ---- detail: task/project settings ----

// La vista de cambios de una tarea: el diff, el commit desde ahí y el
// selector de fixup. Es la pantalla donde se pasa más tiempo, y por sí sola
// ocupaba más que el resto de vistas de detalle juntas.

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
  fixupBtn.addEventListener('click', async () => {
    const selectedPatch = await buildSelectedPatch(raw, checkedFiles, selectedHunks)
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
      const selectedPatch = await buildSelectedPatch(raw, checkedFiles, selectedHunks)
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

    // Qué commit encaja mejor lo decide `bento_review::recommend`: junta el
    // solape de ficheros, el blame y el historial en una sola consulta.
    const enriched = await taskGit.fixupTargets(wt.path, worktreeBase, incomingDiff, files)
    const incomingFiles = new Set(files ?? enriched.flatMap(target => target.overlap))

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
    for (const { entry, files: commitFiles, overlap, history, historyFiles, blame, blameFiles } of enriched) {
      const item = document.createElement('div')
      item.className = `tasks-fixup-item${overlap.length || history || blame ? ' tasks-fixup-item--match' : ''}`
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
          taskT('fixupPreview', { count: incomingFiles.size, target: `${entry.short} ${entry.subject}`, matches: overlap.length ? overlap.join(', ') : taskT('none'), blame: blame || taskT('none'), history: history ? historyFiles.join(', ') : taskT('none'), published: publishedWarning }),
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
        ...(blame ? [Object.assign(document.createElement('span'), {
          className: 'tasks-fixup-blame-badge',
          textContent: taskT('blameLines', { count: blame }),
          title: taskT('blameHint', { files: blameFiles.join(', ') }),
        })] : []),
        ...(!overlap.length && !blame && history ? [Object.assign(document.createElement('span'), {
          className: 'tasks-fixup-history-badge',
          textContent: taskT('historyScore', { count: history }),
          title: taskT('historyHint', { files: historyFiles.join(', ') }),
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
