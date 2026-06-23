// OSC 7 reports the shell's working directory as file://host/path. We use it both
// for the panel title and to restore the cwd when a terminal is reopened.
export function parseOsc7Path(data: string): string | null {
  try {
    const path = decodeURIComponent(new URL(data).pathname)
    return path || null
  } catch {
    return null
  }
}

export function toDisplayPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}
