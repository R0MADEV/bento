import { describe, it, expect } from 'vitest'
import { getDefaultShell } from '../../../src/core/terminal/getDefaultShell'

describe('getDefaultShell', () => {
  it('returns /bin/bash on linux', () => {
    expect(getDefaultShell('linux')).toBe('/bin/bash')
  })

  it('returns /bin/zsh on darwin', () => {
    expect(getDefaultShell('darwin')).toBe('/bin/zsh')
  })

  it('returns powershell.exe on windows', () => {
    expect(getDefaultShell('win32')).toBe('powershell.exe')
  })

  it('falls back to /bin/sh for unknown platforms', () => {
    expect(getDefaultShell('freebsd')).toBe('/bin/sh')
  })
})
