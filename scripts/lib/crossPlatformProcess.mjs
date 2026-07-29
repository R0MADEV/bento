export function npmRunInvocation(script, options = {}) {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const env = options.env ?? process.env
  if (env.npm_execpath) {
    return { command: execPath, args: [env.npm_execpath, 'run', script] }
  }
  if (platform === 'win32') {
    return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'run', script] }
  }
  return { command: 'npm', args: ['run', script] }
}
