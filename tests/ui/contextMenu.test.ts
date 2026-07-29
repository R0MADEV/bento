// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { showContextMenu } from '../../src/ui/contextMenu'

describe('context menu', () => {
  it('exposes a stable test id and invokes its action', () => {
    const onClick = vi.fn()
    showContextMenu(10, 20, [{ label: 'Backups', testId: 'tasks-backups-action', onClick }])

    const item = document.querySelector<HTMLElement>('[data-testid="tasks-backups-action"]')
    expect(item?.tagName).toBe('BUTTON')
    expect(item?.textContent).toBe('Backups')
    item?.click()
    expect(onClick).toHaveBeenCalledOnce()
    expect(document.querySelector('.context-menu')).toBeNull()
  })
})
