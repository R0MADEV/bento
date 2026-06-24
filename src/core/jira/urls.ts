export function normalizeSite(site: string): string {
  return site.replace(/\/+$/, '')
}

export function browseUrl(site: string, key: string): string {
  return `${normalizeSite(site)}/browse/${key}`
}

// path includes the API version, e.g. "api/3/search/jql" or "api/2/issue",
// since Jira Cloud mixes v3 (new search) and v2 (plain-text descriptions).
export function apiUrl(site: string, path: string): string {
  return `${normalizeSite(site)}/rest/${path}`
}
