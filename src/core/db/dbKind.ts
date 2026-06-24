import type { DbKind } from './dbServer'

// Classify a Docker image (e.g. "bitnami/mysql:8") into a database engine.
// mariadb is checked before mysql since it's a distinct image.
export function dbKind(image: string): DbKind | null {
  const name = image.toLowerCase()
  if (name.includes('mariadb')) return 'mariadb'
  if (name.includes('mysql')) return 'mysql'
  if (name.includes('mongo')) return 'mongodb'
  if (name.includes('postgres')) return 'postgres'
  if (name.includes('redis')) return 'redis'
  return null
}
