// From a Docker ports string ("0.0.0.0:3307->3306/tcp, :::3307->3306/tcp"),
// find the host port published for a given internal port. Returns null when the
// internal port isn't published to the host (so it can't be reached).
export function publishedPort(ports: string, internalPort: number): number | null {
  const match = ports.match(new RegExp(`:(\\d+)->${internalPort}(?:/|\\b)`))
  return match ? Number(match[1]) : null
}
