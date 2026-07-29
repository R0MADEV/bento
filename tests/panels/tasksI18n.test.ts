// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTaskLocale, setTaskLocale, taskT } from '../../src/panels/tasks/i18n'
import { makeLocalStorage } from '../helpers/localStorage'

describe('tasks i18n', () => {
  beforeEach(() => vi.stubGlobal('localStorage', makeLocalStorage()))

  it('switches locale and interpolates values', () => {
    setTaskLocale('en')
    expect(getTaskLocale()).toBe('en')
    expect(taskT('changes', { count: 3 })).toBe('3 changes')
    setTaskLocale('es')
    expect(taskT('changes', { count: 3 })).toBe('3 cambios')
  })
})
