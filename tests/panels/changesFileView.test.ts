// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildChangesFileView } from '../../src/panels/tasks/ChangesFileView'
import { makeLocalStorage } from '../helpers/localStorage'

describe('changes file view', () => {
  it('renders patch content lazily and selects individual hunks', () => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    localStorage.setItem('bento.tasks.locale', 'en')
    const chunk = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n'
    const checked = new Set<string>()
    const hunks = new Map<string, Set<number>>()
    const view = buildChangesFileView({ chunk, checkedFiles: checked, selectedHunks: hunks, renderPatch: raw => raw }) as HTMLDetailsElement
    expect(view.querySelector('.tasks-diff-code')).toBeNull()
    view.open = true
    view.dispatchEvent(new Event('toggle'))
    expect(view.textContent).toContain('+new')
    const hunkCheck = view.querySelector('.tasks-hunk-check') as HTMLInputElement
    hunkCheck.checked = true
    hunkCheck.dispatchEvent(new Event('change'))
    expect(checked.has('file.txt')).toBe(true)
  })
})
