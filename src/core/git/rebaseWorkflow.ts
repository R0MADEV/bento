export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop'

export interface RebasePlanItem {
  action: RebaseAction
  hash: string
  short: string
  subject: string
  newMessage?: string
}

export interface RebasePreview {
  resultingCommits: number
  rewrittenCommits: number
  droppedCommits: number
  combinedCommits: number
  editedCommits: number
  warnings: string[]
  lines: string[]
}

export function previewRebase(items: RebasePlanItem[]): RebasePreview {
  const warnings: string[] = []
  const lines: string[] = []
  let resultingCommits = 0
  let droppedCommits = 0
  let combinedCommits = 0
  let editedCommits = 0

  items.forEach((item, index) => {
    if (item.action === 'drop') {
      droppedCommits++
      lines.push(`Eliminar ${item.short} · ${item.subject}`)
      return
    }
    if (item.action === 'fixup' || item.action === 'squash') {
      combinedCommits++
      const target = [...items.slice(0, index)].reverse().find(candidate => candidate.action !== 'drop')
      if (!target) warnings.push(`${item.short} no tiene un commit anterior donde integrarse.`)
      lines.push(`${item.action === 'fixup' ? 'Integrar' : 'Combinar'} ${item.short} → ${target?.short ?? 'sin destino'}`)
      return
    }
    resultingCommits++
    if (item.action === 'edit' || item.action === 'reword') editedCommits++
    lines.push(`${item.action === 'pick' ? 'Conservar' : item.action === 'reword' ? 'Renombrar' : 'Pausar'} ${item.short} · ${item.newMessage || item.subject}`)
  })

  if (items.every(item => item.action === 'drop')) warnings.push('El plan eliminaría todos los commits de la tarea.')
  return {
    resultingCommits,
    rewrittenCommits: items.length - items.filter(item => item.action === 'pick').length,
    droppedCommits,
    combinedCommits,
    editedCommits,
    warnings: [...new Set(warnings)],
    lines,
  }
}

export interface GitOperationEntry {
  id: string
  timestamp: number
  repository: string
  branch: string
  operation: string
  status: 'success' | 'error'
  detail: string
}

export function appendOperation(
  entries: GitOperationEntry[],
  entry: Omit<GitOperationEntry, 'id' | 'timestamp'>,
  now = Date.now(),
  limit = 100,
): GitOperationEntry[] {
  return [{ ...entry, id: `${now}-${entries.length}`, timestamp: now }, ...entries].slice(0, limit)
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
