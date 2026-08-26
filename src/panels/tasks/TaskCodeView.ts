import { fileStateMap } from '../../core/git/fileState'

export { fileStateMap }

import type { CommitFile } from '../../core/git/gitTypes'
import { taskT } from './i18n'

export function escapeCodeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderPatchHtml(raw: string): string {
  return raw.split('\n').map((line, index) => {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? ' tasks-diff-line-add'
      : line.startsWith('-') && !line.startsWith('---') ? ' tasks-diff-line-del'
        : line.startsWith('@@') ? ' tasks-diff-hunk' : ''
    return `<span class="tasks-diff-code-line${cls}"><span class="tasks-diff-line-no">${index + 1}</span>${escapeCodeHtml(line)}</span>`
  }).join('')
}


function renderSourceHtml(raw: string): string {
  return raw.split('\n').map((line, index) => {
    const highlighted = escapeCodeHtml(line).replace(
      /\b(const|let|var|function|class|interface|type|export|import|from|return|if|else|for|while|match|pub|fn|struct|impl|async|await|try|catch)\b/g,
      '<span class="tasks-source-keyword">$1</span>',
    )
    return `<span class="tasks-diff-code-line"><span class="tasks-diff-line-no">${index + 1}</span>${highlighted}</span>`
  }).join('')
}

export function buildCommitFileList(
  files: CommitFile[],
  loadPatch?: (file: string) => Promise<string>,
  loadFullFile?: (file: string) => Promise<string>,
): HTMLElement[] {
  const statusClass: Record<string, string> = { M: 'fl-mod', A: 'fl-add', D: 'fl-del', R: 'fl-ren', C: 'fl-ren', T: 'fl-mod' }
  return files.map(file => {
    const statusCode = file.status[0] ?? 'M'
    const filePath = file.paths.length > 1 ? file.paths.join(' → ') : file.paths[0] ?? ''
    const targetPath = file.paths.at(-1) ?? filePath
    const entry = document.createElement('div')
    entry.className = 'tasks-commit-file-entry'
    const row = document.createElement(loadPatch ? 'button' : 'div')
    row.className = `tasks-commit-file-row${loadPatch ? ' tasks-commit-file-row--openable' : ''}`
    row.append(
      Object.assign(document.createElement('span'), { className: `tasks-file-status ${statusClass[statusCode] ?? 'fl-mod'}`, textContent: statusCode }),
      Object.assign(document.createElement('span'), { className: 'tasks-file-path', textContent: filePath }),
    )
    entry.appendChild(row)
    if (loadPatch) {
      const patch = document.createElement('pre')
      patch.className = 'tasks-commit-file-diff hidden'
      let loaded = false
      row.title = taskT('changedCode')
      row.addEventListener('click', async () => {
        const opening = patch.classList.contains('hidden')
        patch.classList.toggle('hidden', !opening)
        row.classList.toggle('tasks-commit-file-row--expanded', opening)
        if (!opening || loaded) return
        patch.textContent = taskT('loadingCode')
        try {
          const diff = await loadPatch(targetPath)
          patch.innerHTML = diff.trim() ? renderPatchHtml(diff) : `<span>${taskT('noTextPatch')}</span>`
          loaded = true
        } catch (error) { patch.textContent = String(error) }
      })
      entry.appendChild(patch)
    }
    if (loadFullFile) {
      const fullButton = Object.assign(document.createElement('button'), { className: 'tasks-file-full-btn', textContent: taskT('fullFile'), title: taskT('viewFullCommitFile') })
      const full = document.createElement('pre')
      full.className = 'tasks-commit-file-diff tasks-full-file hidden'
      let loaded = false
      fullButton.addEventListener('click', async () => {
        const opening = full.classList.contains('hidden')
        full.classList.toggle('hidden', !opening)
        if (!opening || loaded) return
        full.textContent = taskT('loadFile')
        try { full.innerHTML = renderSourceHtml(await loadFullFile(targetPath)); loaded = true }
        catch (error) { full.textContent = String(error) }
      })
      entry.append(fullButton, full)
    }
    return entry
  })
}
