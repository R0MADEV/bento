import { parseFilePatch } from './taskPatch'
import { taskT } from './i18n'

interface ChangesFileOptions {
  chunk: string
  state?: string
  checkedFiles: Set<string>
  selectedHunks: Map<string, Set<number>>
  renderPatch: (raw: string) => string
}

export function buildChangesFileView(options: ChangesFileOptions): HTMLElement {
  const { chunk, checkedFiles, selectedHunks } = options
  const firstLine = chunk.split('\n')[0] ?? ''
  const fileName = firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
  const lines = chunk.split('\n')
  const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length
  const details = document.createElement('details')
  details.className = 'tasks-diff-file'
  details.dataset.file = fileName
  const summary = document.createElement('summary')
  summary.className = 'tasks-diff-summary'
  const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'tasks-diff-check', title: taskT('includeCommit') })
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      checkedFiles.add(fileName); selectedHunks.delete(fileName)
      details.querySelectorAll<HTMLInputElement>('.tasks-hunk-check').forEach(input => { input.checked = true })
    } else {
      checkedFiles.delete(fileName)
      details.querySelectorAll<HTMLInputElement>('.tasks-hunk-check').forEach(input => { input.checked = false })
    }
    checkbox.indeterminate = false
  })
  checkbox.addEventListener('click', event => event.stopPropagation())
  const state = Object.assign(document.createElement('span'), {
    className: `tasks-file-state${options.state === 'staged' ? ' tasks-file-state--staged' : options.state === 'untracked' ? ' tasks-file-state--untracked' : ''}`,
    textContent: options.state ?? '',
  })
  const stats = document.createElement('span')
  stats.className = 'tasks-diff-stats'
  if (additions) stats.appendChild(Object.assign(document.createElement('span'), { className: 'tasks-diff-add', textContent: `+${additions}` }))
  if (deletions) stats.appendChild(Object.assign(document.createElement('span'), { className: 'tasks-diff-del', textContent: `-${deletions}` }))
  summary.append(checkbox, Object.assign(document.createElement('span'), { className: 'tasks-diff-name', textContent: fileName }), state, stats)

  const body = document.createElement('div')
  body.className = 'tasks-diff-body'
  body.appendChild(Object.assign(document.createElement('div'), { className: 'db-detail-hint', textContent: taskT('loadingCode') }))
  let rendered = false
  details.addEventListener('toggle', async () => {
    if (!details.open || rendered) return
    rendered = true
    body.replaceChildren()
    const patch = await parseFilePatch(chunk)
    if (!patch.hunks.length) {
      body.appendChild(Object.assign(document.createElement('pre'), { className: 'tasks-diff-code', innerHTML: options.renderPatch(chunk) }))
      return
    }
    body.appendChild(Object.assign(document.createElement('pre'), { className: 'tasks-diff-code tasks-diff-code--header', innerHTML: options.renderPatch(patch.header) }))
    patch.hunks.forEach((hunk, hunkIndex) => {
      const block = document.createElement('section')
      block.className = 'tasks-diff-hunk-block'
      const label = document.createElement('label')
      label.className = 'tasks-hunk-select'
      const hunkCheck = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'tasks-hunk-check' })
      hunkCheck.checked = checkedFiles.has(fileName) || selectedHunks.get(fileName)?.has(hunkIndex) === true
      label.append(hunkCheck, document.createTextNode(` ${taskT('includeCommit')} · ${hunk.split('\n')[0] ?? hunkIndex + 1}`))
      hunkCheck.addEventListener('change', () => {
        const selected = selectedHunks.get(fileName) ?? (checkedFiles.has(fileName) ? new Set(patch.hunks.map((_, index) => index)) : new Set<number>())
        if (hunkCheck.checked) selected.add(hunkIndex); else selected.delete(hunkIndex)
        if (selected.size) selectedHunks.set(fileName, selected); else selectedHunks.delete(fileName)
        checkedFiles.delete(fileName)
        checkbox.checked = selected.size === patch.hunks.length
        checkbox.indeterminate = selected.size > 0 && !checkbox.checked
        if (checkbox.checked) { checkedFiles.add(fileName); selectedHunks.delete(fileName) }
      })
      block.append(label, Object.assign(document.createElement('pre'), { className: 'tasks-diff-code', innerHTML: options.renderPatch(hunk) }))
      body.appendChild(block)
    })
  })
  details.append(summary, body)
  return details
}
