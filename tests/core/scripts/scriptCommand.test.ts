import { describe, it, expect } from 'vitest'
import { scriptCommand } from '../../../src/core/scripts/scriptCommand'

describe('scriptCommand', () => {
  it('runs shell scripts with the matching interpreter', () => {
    expect(scriptCommand('/x/deploy.sh')).toBe('bash "/x/deploy.sh"')
    expect(scriptCommand('/x/run.zsh')).toBe('zsh "/x/run.zsh"')
  })

  it('runs python, node and ruby scripts', () => {
    expect(scriptCommand('/x/seed.py')).toBe('python3 "/x/seed.py"')
    expect(scriptCommand('/x/build.js')).toBe('node "/x/build.js"')
    expect(scriptCommand('/x/task.rb')).toBe('ruby "/x/task.rb"')
  })

  it('runs anything else directly (executables)', () => {
    expect(scriptCommand('/usr/local/bin/mytool')).toBe('"/usr/local/bin/mytool"')
  })

  it('is case-insensitive on the extension', () => {
    expect(scriptCommand('/x/DEPLOY.SH')).toBe('bash "/x/DEPLOY.SH"')
  })
})
