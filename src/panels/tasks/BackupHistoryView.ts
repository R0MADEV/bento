import { invoke } from '@tauri-apps/api/core'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { BackupEntry } from '../../core/git/gitTypes'
import { taskT } from './i18n'

interface BackupHistoryOptions {
  path: string
  branch: string
  renderPatch: (raw: string) => string
  onBack: () => void
  onRestored: () => Promise<void> | void
  onOperation: (status: 'success' | 'error', detail: string) => void
}

export async function buildBackupHistoryView(options: BackupHistoryOptions): Promise<HTMLElement> {
  const backups = await invoke<BackupEntry[]>('git_backup_list', { path: options.path })
  const wrap = document.createElement('div')
  wrap.className = 'tasks-log-wrap'
  wrap.dataset.testid = 'tasks-backup-history'
  const subHead = document.createElement('div')
  subHead.className = 'db-detail-header'
  const back = Object.assign(document.createElement('button'), { className: 'db-back-btn', textContent: '←' })
  back.setAttribute('aria-label', taskT('backChanges'))
  back.addEventListener('click', options.onBack)
  subHead.append(back, Object.assign(document.createElement('span'), { textContent: `${taskT('backupTitle')} · ${options.branch}` }))
  wrap.append(subHead, Object.assign(document.createElement('p'), { className: 'tasks-rebase-hint', textContent: taskT('backupHint') }))

  const list = document.createElement('div')
  list.className = 'tasks-backup-list'
  if (!backups.length) list.appendChild(Object.assign(document.createElement('div'), { className: 'db-detail-hint', textContent: taskT('noBackups') }))
  for (const backup of backups) {
    const item = document.createElement('div')
    item.className = 'tasks-backup-item'
    const head = document.createElement('div')
    head.className = 'tasks-fixup-header'
    const diff = document.createElement('pre')
    diff.className = 'tasks-commit-file-diff hidden'
    let loaded = false
    const inspect = Object.assign(document.createElement('button'), { className: 'docker-action', textContent: '⌄', title: taskT('compareBackup') })
    inspect.addEventListener('click', async () => {
      const opening = diff.classList.contains('hidden')
      diff.classList.toggle('hidden', !opening)
      if (!opening || loaded) return
      diff.textContent = taskT('loadingComparison')
      try {
        const raw = await invoke<string>('git_backup_diff', { path: options.path, target: backup.reference })
        diff.innerHTML = raw.trim() ? options.renderPatch(raw) : `<span>${taskT('noDifference')}</span>`
        loaded = true
      } catch (error) { diff.textContent = String(error) }
    })
    const restore = Object.assign(document.createElement('button'), { className: 'tasks-commit-btn', textContent: taskT('restore') })
    restore.addEventListener('click', async () => {
      const accepted = await askConfirm(
        `${taskT('restore')} ${backup.short} “${backup.subject}”?`,
        { title: taskT('restoreBackup'), kind: 'warning' },
      )
      if (!accepted) return
      restore.disabled = true
      try {
        await invoke('git_restore_backup', { path: options.path, target: backup.reference })
        options.onOperation('success', `${backup.short} ${backup.subject}`)
        await options.onRestored()
      } catch (error) {
        options.onOperation('error', String(error))
        restore.disabled = false
        await askConfirm(String(error), { title: taskT('restoreFailed'), kind: 'error' })
      }
    })
    head.append(
      inspect,
      Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: backup.short }),
      Object.assign(document.createElement('span'), { className: 'tasks-rebase-subject', textContent: backup.subject }),
      Object.assign(document.createElement('span'), { className: 'tasks-log-meta-inline', textContent: backup.createdAt ? new Date(backup.createdAt).toLocaleString() : '' }),
      restore,
    )
    item.append(head, diff)
    list.appendChild(item)
  }
  wrap.appendChild(list)
  return wrap
}
