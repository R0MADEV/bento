/** An external folder Bento scans for memories to import. */
export interface MemorySource {
  id: string
  projectPath: string
  kind: 'filesystem'
  label: string
  path: string
  createdAt: string
  updatedAt: string
}

/** A memory found in a source, before the user decides to import it. */
export interface ImportedMemoryCandidate {
  title: string
  summary: string
  details: string
  source: string
  externalId: string
  createdAt: string
  files: string[]
  tags: string[]
}

/** Whether a candidate already exists, so the preview can warn before importing. */
export interface PreviewCandidateState {
  duplicateExternal: boolean
  duplicateSemantic: boolean
  duplicateTitle?: string
}

/** A queued request to summarize an agent session into a memory. */
export interface MemorySummaryJob {
  id: string
  projectPath: string
  agent: 'claude' | 'codex'
  sessionId: string
  transcriptExternalId: string
  transcriptHash: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
  error: string
  attempts: number
  metadataJson: string
  createdAt: string
  updatedAt: string
}
