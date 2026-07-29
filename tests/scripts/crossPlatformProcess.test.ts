import { describe, expect, it } from 'vitest'
import { npmRunInvocation } from '../../scripts/lib/crossPlatformProcess.mjs'

describe('npmRunInvocation', () => {
  it('runs the npm CLI through Node on Windows instead of spawning npm.cmd', () => {
    expect(npmRunInvocation('build', {
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: { npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' },
    })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'build'],
    })
  })

  it('uses cmd.exe only as the Windows fallback when npm_execpath is unavailable', () => {
    expect(npmRunInvocation('build', {
      platform: 'win32',
      execPath: 'node.exe',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm', 'run', 'build'],
    })
  })

  it('keeps the direct npm fallback on Unix', () => {
    expect(npmRunInvocation('build', { platform: 'linux', execPath: '/usr/bin/node', env: {} })).toEqual({
      command: 'npm',
      args: ['run', 'build'],
    })
  })
})
