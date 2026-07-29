import { invoke } from '@tauri-apps/api/core'
import { basicAuth } from '../../core/jira/auth'
import { apiUrl, browseUrl } from '../../core/jira/urls'

export interface JiraConfig { site: string; email: string; token: string }
export interface TaskIssue { key: string; summary: string; statusCategory: string; statusName: string }
export interface JiraTransition { id: string; name: string }

interface HttpResponse { status: number; body: string }

async function jiraRequest(cfg: JiraConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await invoke<HttpResponse>('http_request', {
    method,
    url: apiUrl(cfg.site, path),
    headers: [
      ['Authorization', basicAuth(cfg.email, cfg.token)],
      ['Accept', 'application/json'],
      ['Content-Type', 'application/json'],
    ],
    body: body !== undefined ? JSON.stringify(body) : null,
  })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
  return res.body ? JSON.parse(res.body) : null
}

export async function fetchIssue(key: string, cfg: JiraConfig): Promise<TaskIssue | null> {
  try {
    const json = await jiraRequest(cfg, 'GET', `api/3/issue/${key}?fields=summary,status`) as {
      key?: string; fields?: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } }
    }
    return {
      key: json.key ?? key,
      summary: json.fields?.summary ?? '',
      statusName: json.fields?.status?.name ?? '',
      statusCategory: json.fields?.status?.statusCategory?.key ?? '',
    }
  } catch {
    return null
  }
}

export async function fetchTransitions(key: string, cfg: JiraConfig): Promise<JiraTransition[]> {
  try {
    const json = await jiraRequest(cfg, 'GET', `api/3/issue/${key}/transitions`) as { transitions?: { id?: string; name?: string }[] }
    return (json.transitions ?? []).map(t => ({ id: t.id ?? '', name: t.name ?? '' })).filter(t => t.id)
  } catch {
    return []
  }
}

export async function applyTransition(key: string, transitionId: string, cfg: JiraConfig): Promise<void> {
  await jiraRequest(cfg, 'POST', `api/3/issue/${key}/transitions`, { transition: { id: transitionId } })
}

export async function loadJiraConfig(): Promise<JiraConfig | null> {
  try {
    const cfg = await invoke<JiraConfig>('jira_config_get')
    if (!cfg.site || !cfg.email || !cfg.token) return null
    return cfg
  } catch {
    return null
  }
}

export { browseUrl }
