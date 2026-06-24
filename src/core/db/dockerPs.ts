export interface DockerContainer {
  name: string
  image: string
  ports: string
}

// Parse the output of `docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}'`.
export function parseDockerPs(raw: string): DockerContainer[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name = '', image = '', ports = ''] = line.split('|')
      return { name: name.trim(), image: image.trim(), ports: ports.trim() }
    })
}
