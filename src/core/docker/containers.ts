export interface Container {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
}

// Parse `docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}'`.
export function parseContainers(raw: string): Container[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [id = '', name = '', image = '', state = '', status = '', ports = ''] = line.split('|')
      return { id: id.trim(), name: name.trim(), image: image.trim(), state: state.trim(), status: status.trim(), ports: ports.trim() }
    })
}

export function isRunning(c: Container): boolean {
  return c.state === 'running'
}
