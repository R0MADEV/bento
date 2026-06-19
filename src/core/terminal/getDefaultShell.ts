const SHELLS: Record<string, string> = {
  linux: '/bin/bash',
  darwin: '/bin/zsh',
  win32: 'powershell.exe',
}

export function getDefaultShell(platform: string): string {
  return SHELLS[platform] ?? '/bin/sh'
}
