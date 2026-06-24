// The shell command to run a script, picking the interpreter from its extension.
const INTERPRETERS: Record<string, string> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  py: 'python3',
  js: 'node',
  rb: 'ruby',
}

export function scriptCommand(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const interpreter = INTERPRETERS[ext]
  return interpreter ? `${interpreter} "${path}"` : `"${path}"`
}
