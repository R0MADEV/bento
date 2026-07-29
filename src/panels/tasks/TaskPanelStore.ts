import { appendOperation, type GitOperationEntry } from '../../core/git/rebaseWorkflow'

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
  }

  base(): string { return localStorage.getItem(this.key('base')) ?? 'main' }
  savedBase(): string | null { return localStorage.getItem(this.key('base')) }
  setBase(branch: string): void { localStorage.setItem(this.key('base'), branch) }

  selected(): string | null { return localStorage.getItem(this.key('selected')) }
  setSelected(path: string): void { localStorage.setItem(this.key('selected'), path) }

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
