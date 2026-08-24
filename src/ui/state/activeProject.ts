let activeProjectPath = ''

export const setActiveProjectPath = (projectPath: string | undefined): void => {
  activeProjectPath = projectPath?.trim() ?? ''
}

export const getActiveProjectPath = (): string => activeProjectPath
