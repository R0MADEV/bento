// The folder name of a project path (last segment), for naming a session.
export function projectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? ''
}
