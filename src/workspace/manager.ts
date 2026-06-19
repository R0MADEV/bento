import { WorkspaceConfig } from './types'

export class WorkspaceManager {
  private currentWorkspace: WorkspaceConfig | null = null

  async load(workspaceName: string): Promise<WorkspaceConfig> {
    // TODO: Fase 6 — load from ~/.config/bento/workspaces/{name}.json
    throw new Error('Not implemented')
  }

  async save(workspace: WorkspaceConfig): Promise<void> {
    // TODO: Fase 6 — save to ~/.config/bento/workspaces/{name}.json
    this.currentWorkspace = workspace
  }

  getCurrent(): WorkspaceConfig | null {
    return this.currentWorkspace
  }
}

export const workspaceManager = new WorkspaceManager()
