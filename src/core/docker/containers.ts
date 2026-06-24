export interface Container {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  project: string
}

export interface ProjectGroup {
  project: string
  containers: Container[]
}

// Parse docker ps with the compose project label appended as the 7th field.
export function parseContainers(raw: string): Container[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [id = '', name = '', image = '', state = '', status = '', ports = '', project = ''] = line.split('|')
      return {
        id: id.trim(), name: name.trim(), image: image.trim(), state: state.trim(),
        status: status.trim(), ports: ports.trim(), project: project.trim(),
      }
    })
}

export function isRunning(c: Container): boolean {
  return c.state === 'running'
}

export function runningCount(containers: Container[]): number {
  return containers.filter(isRunning).length
}

// Group containers by their Docker Compose project, projects sorted A→Z, with
// standalone containers (no project) collected last under the empty key.
export function groupByProject(containers: Container[]): ProjectGroup[] {
  const map = new Map<string, Container[]>()
  for (const c of containers) {
    const key = c.project || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(c)
  }
  const named = [...map.entries()]
    .filter(([k]) => k !== '')
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, containers]) => ({ project, containers }))
  const orphans = map.get('')
  return orphans ? [...named, { project: '', containers: orphans }] : named
}
