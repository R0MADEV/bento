export type MemoryKind = 'decision' | 'fact' | 'task' | 'note'

export interface MemoryEntry {
  id: string
  projectPath: string
  kind: MemoryKind
  title: string
  summary: string
  details: string
  tags: string[]
  files: string[]
  source: string
  externalId: string
  createdAt: string
  updatedAt: string
}

export interface NewMemoryEntry {
  kind: MemoryKind
  title: string
  summary: string
  details?: string
  tags?: string[]
  files?: string[]
  source?: string
  externalId?: string
  createdAt?: string
  updatedAt?: string
}

export interface UpdateMemoryEntry {
  kind?: MemoryKind
  title?: string
  summary?: string
  details?: string
  tags?: string[]
  files?: string[]
  source?: string
  externalId?: string
  createdAt?: string
  updatedAt?: string
}
