import { dbKind } from './dbKind'
import { exposedPorts } from './exposedPorts'
import { DEFAULT_PORT, kindForPort, type DbKind } from './dbServer'

// Classify a container into a database engine. Trust the image name only when the
// engine's port is exposed (or no port is) — this rejects tools like
// redis/redisinsight that carry the engine name but listen on another port.
// Otherwise fall back to the exposed port, which catches custom images (aps-db).
export function serverKind(image: string, ports: string): DbKind | null {
  const exposed = exposedPorts(ports)
  const byImage = dbKind(image)
  const imageConfirmed = byImage && (exposed.length === 0 || exposed.includes(DEFAULT_PORT[byImage]))
  if (imageConfirmed) return byImage
  return exposed.map(kindForPort).find(Boolean) ?? null
}
