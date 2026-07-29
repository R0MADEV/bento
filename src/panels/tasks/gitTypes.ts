export interface PrCheck {
  conclusion?: string
  state?: string
  status?: string
  name?: string
  context?: string
}

export interface PrStatus {
  state: string
  title: string
  url: string
  number: number
  baseRefName?: string
  isDraft?: boolean
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''
  statusCheckRollup?: PrCheck[]
}

export interface BackupStatus {
  available: boolean
  different?: boolean
  hash?: string
  short?: string
  subject?: string
}

export interface BackupEntry {
  reference: string
  hash: string
  short: string
  subject: string
  createdAt: number
}

export interface RebaseStatus {
  active: boolean
  sha?: string
  short?: string
  subject?: string
  body?: string
  branch?: string
  current?: number
  total?: number
  conflicts?: string[]
}

export interface UpstreamStatus {
  branch: string
  upstream?: string
  hasUpstream: boolean
  state: 'unpublished' | 'synced' | 'ahead' | 'behind' | 'diverged'
  ahead: number
  behind: number
}

export interface RewritePreflight {
  branch: string
  base: string
  dirty: boolean
  operation: string
  upstream: string
  publishedCommits: number
  protectedBase: boolean
  signing: boolean
  hooks: string[]
}
