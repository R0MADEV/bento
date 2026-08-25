// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { buildChangesFileView } from '../../../src/panels/tasks/ChangesFileView'

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('changes file view', () => {
  it('renders patch content lazily and selects individual hunks', async () => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    localStorage.setItem('bento.tasks.locale', 'en')
    const chunk = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n'
    // Partir el fichero en trozos es de `bento_review::diff`: quien pinta y
    // quien arma el parche tienen que contarlos igual.
    mocks.invoke.mockResolvedValue({
      file: 'file.txt',
      header: 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n',
      hunks: ['@@ -1 +1 @@\n-old\n+new\n'],
    })
    const checked = new Set<string>()
    const hunks = new Map<string, Set<number>>()
    const view = buildChangesFileView({ chunk, checkedFiles: checked, selectedHunks: hunks, renderPatch: raw => raw }) as HTMLDetailsElement
    expect(view.querySelector('.tasks-diff-code')).toBeNull()
    view.open = true
    view.dispatchEvent(new Event('toggle'))
    await flush()
    expect(mocks.invoke).toHaveBeenCalledWith('git_parse_file_patch', { chunk })
    expect(view.textContent).toContain('+new')
    const hunkCheck = view.querySelector('.tasks-hunk-check') as HTMLInputElement
    hunkCheck.checked = true
    hunkCheck.dispatchEvent(new Event('change'))
    expect(checked.has('file.txt')).toBe(true)
  })
})
