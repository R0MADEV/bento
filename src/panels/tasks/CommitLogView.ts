import { invoke } from '@tauri-apps/api/core'
import type { Worktree } from '../../core/git/worktree'
import type { CommitEntry, CommitFile } from '../../core/git/gitTypes'
import { taskT } from './i18n'

export function buildCommitLogView(options: {
  worktree: Worktree
  entries: CommitEntry[]
  buildSubHead: (title: string, goBack: () => void) => HTMLElement
  onBack: () => void
  showDetail: (...nodes: HTMLElement[]) => void
  note: (text: string, cls?: string) => HTMLElement
  iconBtn: (name: string, title: string, onClick: () => void) => HTMLButtonElement
  buildCommitFileList: (files: CommitFile[], diff: (file: string) => Promise<string>, content: (file: string) => Promise<string>) => HTMLElement[]
  loadFiles: (path: string, hash: string) => Promise<CommitFile[]>
}): void {
  const { worktree: wt, entries, buildSubHead, onBack, showDetail, note, iconBtn, buildCommitFileList, loadFiles } = options
  const wrap = document.createElement('div')
  wrap.className = 'tasks-log-wrap'
  wrap.append(buildSubHead(taskT('historyTitle', { branch: wt.branch ?? '' }), onBack))
  const list = document.createElement('div')
  list.className = 'tasks-log-list'
  if (entries.length === 0) list.appendChild(note(taskT('noBranchCommits'), 'db-detail-hint'))
  for (const entry of entries) {
    const item = document.createElement('div')
    item.className = 'tasks-log-item'
    const filesEl = document.createElement('div')
    filesEl.className = 'tasks-commit-files hidden'
    let filesLoaded = false
    const expandBtn = iconBtn('chevron-down', taskT('viewCommitFiles'), async () => {
      const isOpen = !filesEl.classList.contains('hidden')
      if (isOpen) { filesEl.classList.add('hidden'); expandBtn.title = taskT('viewCommitFiles'); return }
      filesEl.classList.remove('hidden'); expandBtn.title = taskT('hideFiles')
      if (filesLoaded) return
      filesLoaded = true
      filesEl.textContent = taskT('loading')
      const files = await loadFiles(wt.path, entry.hash)
      filesEl.replaceChildren(...buildCommitFileList(
        files,
        file => invoke<string>('git_show_commit_diff', { path: wt.path, hash: entry.hash, file }),
        file => invoke<string>('git_show_file', { path: wt.path, hash: entry.hash, file }),
      ))
    })
    expandBtn.className = 'tasks-expand-btn'
    const header = document.createElement('div')
    header.className = 'tasks-log-item-header'
    header.append(
      Object.assign(document.createElement('span'), { className: 'tasks-log-short', textContent: entry.short }),
      Object.assign(document.createElement('span'), { className: 'tasks-log-subject', textContent: entry.subject }),
      Object.assign(document.createElement('span'), { className: 'tasks-log-meta', textContent: `${entry.author} · ${entry.date}` }),
      expandBtn,
    )
    item.append(header, filesEl)
    list.appendChild(item)
  }
  wrap.appendChild(list)
  showDetail(wrap)
}
