import { describe, expect, it } from 'vitest'
import { findTransitionForColumn, type JiraTransition } from '../../../src/core/jira/transitions'
import type { AgileColumn } from '../../../src/core/jira/board'

const transition = (id: string, toName: string, toId: string, category = 'new'): JiraTransition =>
  ({ id, name: toName, to: { id: toId, name: toName, statusCategory: { key: category } } })

const column = (name: string, statusIds: string[] = []): AgileColumn => ({ name, statusIds })

describe('matching by name', () => {
  it('matches the target status name', () => {
    const found = findTransitionForColumn([transition('1', 'In Progress', '3')], 'In Progress', null)
    expect(found?.id).toBe('1')
  })

  it('matches the transition name when the target status is named differently', () => {
    const t: JiraTransition = { id: '2', name: 'Start work', to: { id: '3', name: 'Doing', statusCategory: { key: 'indeterminate' } } }
    expect(findTransitionForColumn([t], 'Start work', null)?.id).toBe('2')
  })
})

describe('matching by the column status ids', () => {
  it('matches a transition whose target status the column holds', () => {
    const transitions = [transition('7', 'Doing', '10021', 'indeterminate')]
    const cols = [column('In Progress', ['10021'])]
    expect(findTransitionForColumn(transitions, 'In Progress', cols)?.id).toBe('7')
  })

  it('ignores columns other than the target one', () => {
    const transitions = [transition('7', 'Doing', '10021', 'indeterminate')]
    const cols = [column('Done', ['10021']), column('In Progress', [])]
    expect(findTransitionForColumn(transitions, 'In Progress', cols)).toBeUndefined()
  })
})

describe('falling back to the status category', () => {
  it('treats a column that holds statuses as in-progress', () => {
    const transitions = [transition('9', 'Whatever', '5', 'indeterminate')]
    const cols = [column('Custom', ['999'])]
    expect(findTransitionForColumn(transitions, 'Custom', cols)?.id).toBe('9')
  })

  it('treats a column with no statuses as to-do', () => {
    const transitions = [transition('9', 'Whatever', '5', 'new')]
    expect(findTransitionForColumn(transitions, 'Custom', [column('Custom', [])])?.id).toBe('9')
  })

  it('treats an unknown column as to-do', () => {
    const transitions = [transition('9', 'Whatever', '5', 'new')]
    expect(findTransitionForColumn(transitions, 'Nowhere', null)?.id).toBe('9')
  })

  it('does not fall back to a done transition', () => {
    const transitions = [transition('9', 'Whatever', '5', 'done')]
    expect(findTransitionForColumn(transitions, 'Custom', [column('Custom', [])])).toBeUndefined()
  })
})

describe('precedence and misses', () => {
  it('prefers the name match over the category fallback', () => {
    const transitions = [
      transition('fallback', 'Other', '1', 'new'),
      transition('byName', 'Target', '2', 'done'),
    ]
    expect(findTransitionForColumn(transitions, 'Target', null)?.id).toBe('byName')
  })

  it('finds nothing when there are no transitions at all', () => {
    expect(findTransitionForColumn([], 'In Progress', null)).toBeUndefined()
  })
})
