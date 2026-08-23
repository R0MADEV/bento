import { describe, it, expect } from 'vitest'
import { boardCategory, groupByCategory, parseAgileBoards, parseAgileColumns, mapToAgileColumns, statusCategoryClass } from '../../../src/core/jira/board'
import type { JiraIssue } from '../../../src/core/jira/issues'

const issue = (key: string, statusId: string, statusCategory = ''): JiraIssue =>
  ({ key, summary: '', status: '', statusId, statusCategory, type: '', assignee: '', assigneeId: '', assigneeAvatar: '' })

describe('boardCategory', () => {
  it('maps jira statusCategory keys to board columns', () => {
    expect(boardCategory('new')).toBe('todo')
    expect(boardCategory('indeterminate')).toBe('inProgress')
    expect(boardCategory('done')).toBe('done')
  })

  it('treats unknown category as todo', () => {
    expect(boardCategory('')).toBe('todo')
    expect(boardCategory('undefined')).toBe('todo')
  })
})

describe('groupByCategory', () => {
  it('distributes issues across the three columns', () => {
    const issues = [
      issue('A-1', '', 'new'),
      issue('A-2', '', 'indeterminate'),
      issue('A-3', '', 'done'),
      issue('A-4', '', 'new'),
    ]
    const groups = groupByCategory(issues)
    expect(groups.todo.map(i => i.key)).toEqual(['A-1', 'A-4'])
    expect(groups.inProgress.map(i => i.key)).toEqual(['A-2'])
    expect(groups.done.map(i => i.key)).toEqual(['A-3'])
  })

  it('returns empty columns when there are no issues', () => {
    const groups = groupByCategory([])
    expect(groups.todo).toEqual([])
    expect(groups.inProgress).toEqual([])
    expect(groups.done).toEqual([])
  })
})

describe('parseAgileBoards', () => {
  it('extracts id and name from agile board list', () => {
    const json = { values: [{ id: 22, name: 'My Board' }, { id: 5, name: 'Sprint' }] }
    expect(parseAgileBoards(json)).toEqual([{ id: 22, name: 'My Board' }, { id: 5, name: 'Sprint' }])
  })

  it('returns empty on invalid input', () => {
    expect(parseAgileBoards({})).toEqual([])
    expect(parseAgileBoards(null)).toEqual([])
  })
})

describe('parseAgileColumns', () => {
  it('extracts column names and their status IDs', () => {
    const json = {
      columnConfig: {
        columns: [
          { name: 'To Do', statuses: [{ id: '10000' }, { id: '10001' }] },
          { name: 'In Progress', statuses: [{ id: '10002' }] },
          { name: 'Done', statuses: [{ id: '10003' }] },
        ],
      },
    }
    expect(parseAgileColumns(json)).toEqual([
      { name: 'To Do', statusIds: ['10000', '10001'] },
      { name: 'In Progress', statusIds: ['10002'] },
      { name: 'Done', statusIds: ['10003'] },
    ])
  })

  it('returns empty on invalid input', () => {
    expect(parseAgileColumns({})).toEqual([])
  })
})

describe('mapToAgileColumns', () => {
  const columns = [
    { name: 'To Do', statusIds: ['10000'] },
    { name: 'In Progress', statusIds: ['10002'] },
    { name: 'Done', statusIds: ['10003'] },
  ]

  it('maps issues to columns by statusId', () => {
    const issues = [issue('A-1', '10000'), issue('A-2', '10002'), issue('A-3', '10003')]
    const map = mapToAgileColumns(issues, columns)
    expect(map.get('To Do')?.map(i => i.key)).toEqual(['A-1'])
    expect(map.get('In Progress')?.map(i => i.key)).toEqual(['A-2'])
    expect(map.get('Done')?.map(i => i.key)).toEqual(['A-3'])
  })

  it('falls back to first column for unknown statusId', () => {
    const issues = [issue('A-1', '99999')]
    const map = mapToAgileColumns(issues, columns)
    expect(map.get('To Do')?.map(i => i.key)).toEqual(['A-1'])
  })
})

describe('statusCategoryClass', () => {
  it('maps done', () => {
    expect(statusCategoryClass('done')).toBe('jira-st-done')
  })

  it('maps in-progress (indeterminate)', () => {
    expect(statusCategoryClass('indeterminate')).toBe('jira-st-progress')
  })

  it('maps to-do (new) and anything else', () => {
    expect(statusCategoryClass('new')).toBe('jira-st-todo')
    expect(statusCategoryClass('')).toBe('jira-st-todo')
  })
})
