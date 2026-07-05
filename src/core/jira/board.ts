import type { JiraIssue } from './issues'

export type BoardCategory = 'todo' | 'inProgress' | 'done'

export interface BoardColumn { key: BoardCategory; label: string }

export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'todo', label: 'Por hacer' },
  { key: 'inProgress', label: 'En progreso' },
  { key: 'done', label: 'Hecho' },
]

const CATEGORY_MAP: Record<string, BoardCategory> = {
  new: 'todo',
  indeterminate: 'inProgress',
  done: 'done',
}

export function boardCategory(statusCategoryKey: string): BoardCategory {
  return CATEGORY_MAP[statusCategoryKey] ?? 'todo'
}

export function groupByCategory(issues: JiraIssue[]): Record<BoardCategory, JiraIssue[]> {
  const groups: Record<BoardCategory, JiraIssue[]> = { todo: [], inProgress: [], done: [] }
  for (const issue of issues) {
    groups[boardCategory(issue.statusCategory)].push(issue)
  }
  return groups
}

// ---- Agile board API types ----

export interface AgileBoard { id: number; name: string }

export interface AgileColumn { name: string; statusIds: string[] }

// Parse /rest/agile/1.0/board response.
export function parseAgileBoards(json: unknown): AgileBoard[] {
  const values = (json as { values?: unknown })?.values
  if (!Array.isArray(values)) return []
  return values.map(b => ({ id: b?.id ?? 0, name: b?.name ?? '' })).filter(b => b.id)
}

// Parse /rest/agile/1.0/board/{id}/configuration → column list with status IDs.
export function parseAgileColumns(json: unknown): AgileColumn[] {
  const cols = (json as { columnConfig?: { columns?: unknown } })?.columnConfig?.columns
  if (!Array.isArray(cols)) return []
  return cols.map(c => ({
    name: c?.name ?? '',
    statusIds: Array.isArray(c?.statuses) ? c.statuses.map((s: { id?: string }) => String(s?.id ?? '')) : [],
  })).filter(c => c.name)
}

// Group issues into Agile board columns by status ID.
export function mapToAgileColumns(issues: JiraIssue[], columns: AgileColumn[]): Map<string, JiraIssue[]> {
  const result = new Map<string, JiraIssue[]>(columns.map(c => [c.name, []]))
  const statusToCol = new Map<string, string>()
  for (const col of columns) {
    for (const id of col.statusIds) statusToCol.set(id, col.name)
  }
  // Fallback bucket for issues whose status doesn't match any column.
  const firstCol = columns[0]?.name ?? ''
  for (const issue of issues) {
    const colName = statusToCol.get(issue.statusId ?? '') ?? firstCol
    result.get(colName)?.push(issue)
  }
  return result
}
