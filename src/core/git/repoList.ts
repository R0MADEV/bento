// Pure helpers for the Tasks panel's multi-repo list. Paths are normalized
// (no trailing slash) and de-duplicated; order is preserved.

const normalize = (path: string): string => path.trim().replace(/\/+$/, '')

export function addRepo(list: string[], path: string): string[] {
  const p = normalize(path)
  if (!p || list.includes(p)) return list
  return [...list, p]
}

export function removeRepo(list: string[], path: string): string[] {
  const p = normalize(path)
  return list.filter(r => r !== p)
}
