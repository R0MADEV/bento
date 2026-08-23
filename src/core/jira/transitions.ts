import { boardCategory, type AgileColumn } from './board'

export interface JiraTransition {
  id: string
  name: string
  to: { id: string; name: string; statusCategory: { key: string } }
}

/**
 * The transition that moves an issue into a board column, tried three ways:
 * by the column's name, by the statuses the column holds, and finally by the
 * category the column looks like — a column with statuses reads as in-progress,
 * an empty or unknown one as to-do.
 */
export function findTransitionForColumn(
  transitions: JiraTransition[], targetColumnName: string, columns: AgileColumn[] | null,
): JiraTransition | undefined {
  const byName = transitions.find(t => t.to.name === targetColumnName || t.name === targetColumnName)
  if (byName) return byName

  const targetColumn = columns?.find(c => c.name === targetColumnName)
  const byStatusId = targetColumn && transitions.find(t => targetColumn.statusIds.includes(t.to.id))
  if (byStatusId) return byStatusId

  const columnHoldsStatuses = Boolean(targetColumn?.statusIds[0])
  const wantedCategory = boardCategory(columnHoldsStatuses ? 'indeterminate' : 'new')
  return transitions.find(t => boardCategory(t.to.statusCategory.key) === wantedCategory)
}
