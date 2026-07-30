import { invoke } from '@tauri-apps/api/core'
import { taskT } from './i18n'
import { escapeCodeHtml as escHtml } from './TaskCodeView'
import type { Worktree } from '../../core/git/worktree'

export async function buildGraphView(options: {
  worktree: Worktree
  baseBranch: string
  buildSubHead: (title: string, goBack: () => void) => HTMLElement
  onBack: () => void
  showDetail: (...nodes: HTMLElement[]) => void
  note: (text: string, cls?: string) => HTMLElement
}): Promise<void> {
  const { worktree, baseBranch, buildSubHead, onBack, showDetail, note } = options
  showDetail(note(taskT('loadingGraph'), 'db-detail-loading'))
  try {
    const raw = await invoke<string>('git_graph', { path: worktree.path, base: baseBranch })
    const wrap = document.createElement('div')
    wrap.className = 'tasks-graph-wrap'
    wrap.append(buildSubHead(taskT('graphTitle', { branch: worktree.branch ?? '', base: baseBranch }), onBack))
    wrap.appendChild(Object.assign(document.createElement('p'), { className: 'tasks-rebase-hint', textContent: taskT('graphHint') }))
    const graph = document.createElement('pre')
    graph.className = 'tasks-git-graph'
    graph.innerHTML = raw.split('\n').map(line => escHtml(line)
      .replace(/\b([0-9a-f]{7,40})\b/, '<span class="tasks-graph-hash">$1</span>')
      .replace(/\(([^)]+)\)/g, '<span class="tasks-graph-ref">($1)</span>')).join('\n')
    wrap.appendChild(graph)
    showDetail(wrap)
  } catch (error) { showDetail(note(String(error), 'db-detail-error')) }
}
