import { appendOperation, type GitOperationEntry } from '../../core/git/rebaseWorkflow'
import { addRepo, removeRepo } from '../../core/git/repoList'

export class TaskPanelStore {
  private readonly prefix: string

  constructor(panelId: string) {
    this.prefix = `bento.tasks.${panelId}`
  }

  private key(name: string): string {
    // Preserve existing keys while centralizing their construction.
    return `bento.tasks.${name}.${this.prefix.slice('bento.tasks.'.length)}`
  }

  repository(): string { return localStorage.getItem(this.key('repo')) ?? '' }
  setRepository(path: string): void {
    localStorage.setItem(this.key('repo'), path)
    localStorage.removeItem(this.key('base'))
    localStorage.removeItem(this.key('projectKey'))
    localStorage.removeItem(this.key('devcontainerDir'))
  }

  // Multi-repo list. Migrates from the legacy single `repo` key only when the
  // `repos` key was never written — once it exists (even as []), it wins, so
  // removing the last repo doesn't resurrect the legacy value.
  repositories(): string[] {
    const stored = localStorage.getItem(this.key('repos'))
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) return parsed as string[]
      } catch { /* corrupt — fall through to migration */ }
    }
    const legacy = this.repository()
    return legacy ? [legacy] : []
  }
  private setRepositories(list: string[]): void {
    localStorage.setItem(this.key('repos'), JSON.stringify(list))
  }
  addRepository(path: string): void { this.setRepositories(addRepo(this.repositories(), path)) }
  removeRepository(path: string): void { this.setRepositories(removeRepo(this.repositories(), path)) }

  projectKey(): string | null { return localStorage.getItem(this.key('projectKey')) }
  setProjectKey(projectKey: string): void {
    if (projectKey.trim()) localStorage.setItem(this.key('projectKey'), projectKey.trim())
    else localStorage.removeItem(this.key('projectKey'))
  }

  devcontainerDir(): string | null { return localStorage.getItem(this.key('devcontainerDir')) }
  setDevcontainerDir(path: string): void { localStorage.setItem(this.key('devcontainerDir'), path) }

  base(): string { return localStorage.getItem(this.key('base')) ?? 'main' }
  savedBase(): string | null { return localStorage.getItem(this.key('base')) }
  setBase(branch: string): void { localStorage.setItem(this.key('base'), branch) }

  selected(): string | null { return localStorage.getItem(this.key('selected')) }
  setSelected(path: string): void { localStorage.setItem(this.key('selected'), path) }

  sidebarWidth(): number | null {
    const width = Number(localStorage.getItem(this.key('sidebarWidth')))
    const isValidWidth = Number.isFinite(width) && width > 0
    return isValidWidth ? width : null
  }
  setSidebarWidth(width: number): void { localStorage.setItem(this.key('sidebarWidth'), String(Math.round(width))) }

  operations(): GitOperationEntry[] {
    try { return JSON.parse(localStorage.getItem(this.key('gitOperations')) ?? '[]') as GitOperationEntry[] }
    catch { return [] }
  }

  recordOperation(repository: string, branch: string, operation: string, status: 'success' | 'error', detail: string): void {
    const entries = appendOperation(this.operations(), {
      repository,
      branch,
      operation,
      status,
      detail: detail.replace(/(token|password|authorization)\s*[:=]\s*\S+/gi, '$1=[hidden]').slice(0, 500),
    })
    localStorage.setItem(this.key('gitOperations'), JSON.stringify(entries))
  }

  clearOperations(repository: string, branch: string): void {
    const remaining = this.operations().filter(entry => entry.repository !== repository || entry.branch !== branch)
    localStorage.setItem(this.key('gitOperations'), JSON.stringify(remaining))
  }
}
